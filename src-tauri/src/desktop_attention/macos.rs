use std::sync::{mpsc, OnceLock};

use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, ProtocolObject},
    AnyThread,
};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use super::{AgentNotification, ClickHandler};

const SESSION_ID_KEY: &str = "sessionId";

static ON_CLICK: OnceLock<ClickHandler> = OnceLock::new();

define_class!(
    // SAFETY: NSObject has no subclassing requirements and the class does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "SorenoNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        // Without this, macOS hides notifications while Soreno is frontmost, yet they target
        // sessions that are not on screen.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            if let (Some(on_click), Some(session_id)) = (ON_CLICK.get(), session_id(response)) {
                on_click(session_id);
            }
            completion_handler.call(());
        }
    }
);

/// Must run before launch completes so clicks on notifications of a previous run are delivered.
pub(super) fn install_delegate(on_click: ClickHandler) {
    if !is_bundled() || ON_CLICK.set(on_click).is_err() {
        return;
    }
    let delegate = NotificationDelegate::alloc().set_ivars(());
    // SAFETY: plain NSObject initializer.
    let delegate: Retained<NotificationDelegate> = unsafe { msg_send![super(delegate), init] };
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center only keeps a weak reference: the delegate must live as long as the process.
    std::mem::forget(delegate);
}

pub(super) fn show(notification: &AgentNotification) -> Result<(), String> {
    if !is_bundled() {
        return Err(
            "Notifications système indisponibles hors de l'application Soreno empaquetée (.app)."
                .to_string(),
        );
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    authorize(&center)?;

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&notification.title));
    content.setBody(&NSString::from_str(&notification.body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let key = NSString::from_str(SESSION_ID_KEY);
    let session_id = NSString::from_str(&notification.session_id);
    let user_info = NSDictionary::from_slices(&[&*key], &[&*session_id]);
    // SAFETY: userInfo only needs property-list values; both keys and values are NSString.
    unsafe { content.setUserInfo(user_info.cast_unchecked::<AnyObject, AnyObject>()) };
    // Reusing the session id replaces the previous notification of the same session.
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&session_id, &content, None);

    let (sender, receiver) = mpsc::channel();
    let completion = RcBlock::new(move |error: *mut NSError| {
        // SAFETY: the framework passes either null or a valid NSError.
        let message =
            unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
        let _ = sender.send(message);
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    match receiver.recv() {
        Ok(None) => Ok(()),
        Ok(Some(message)) => Err(format!("Notification macOS impossible : {message}")),
        Err(_) => Err("Notification macOS impossible : aucune réponse du système.".to_string()),
    }
}

/// UNUserNotificationCenter raises an Objective-C exception outside a bundled .app.
fn is_bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Prompts the user the first time; afterwards macOS answers immediately with the saved choice.
fn authorize(center: &UNUserNotificationCenter) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    let completion = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = sender.send(granted.as_bool());
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge,
        &completion,
    );
    match receiver.recv() {
        Ok(true) => Ok(()),
        _ => Err(
            "Notifications refusées : autorisez Soreno dans Réglages Système > Notifications."
                .to_string(),
        ),
    }
}

fn session_id(response: &UNNotificationResponse) -> Option<String> {
    let user_info = response.notification().request().content().userInfo();
    let value = user_info.objectForKey(&NSString::from_str(SESSION_ID_KEY))?;
    Some(value.downcast::<NSString>().ok()?.to_string())
}
