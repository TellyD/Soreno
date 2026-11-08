use super::*;

fn notification(title: &str, body: &str) -> AgentNotification {
    AgentNotification {
        title: title.to_string(),
        body: body.to_string(),
        session_id: "session-1".to_string(),
    }
}

fn pixel(rgba: &[u8], x: usize, y: usize) -> &[u8] {
    let start = (y * BADGE_SIZE + x) * 4;
    &rgba[start..start + 4]
}

#[test]
fn toast_xml_escapes_agent_text() {
    let xml = toast_xml(&notification(
        "Projet <R&D>",
        "Réponse \"attendue\" d'ici </text>",
    ));

    assert!(xml.contains("<text>Projet &lt;R&amp;D&gt;</text>"));
    assert!(xml.contains("<text>Réponse &quot;attendue&quot; d&apos;ici &lt;/text&gt;</text>"));
}

#[test]
fn badge_label_hides_zero_and_caps_large_counts() {
    assert_eq!(badge_label(0), None);
    assert_eq!(badge_label(1).as_deref(), Some("1"));
    assert_eq!(badge_label(9).as_deref(), Some("9"));
    assert_eq!(badge_label(10).as_deref(), Some("9+"));
    assert_eq!(badge_label(u32::MAX).as_deref(), Some("9+"));
}

#[test]
fn badge_rgba_draws_a_white_label_on_an_opaque_red_disc() {
    for label in ["1", "9", "9+"] {
        let rgba = badge_rgba(label);
        assert_eq!(rgba.len(), BADGE_SIZE * BADGE_SIZE * 4);
        assert_eq!(
            pixel(&rgba, 0, 0)[3],
            0,
            "{label}: corners stay transparent"
        );
        assert_eq!(pixel(&rgba, BADGE_SIZE / 2, 2), &[0xE5, 0x48, 0x4D, 0xFF]);
        let white = rgba
            .chunks(4)
            .filter(|p| *p == [0xFF, 0xFF, 0xFF, 0xFF])
            .count();
        assert!(
            white > 20,
            "{label}: label is visible ({white} white pixels)"
        );
    }
    assert_ne!(badge_rgba("1"), badge_rgba("9"));
    assert_ne!(badge_rgba("9"), badge_rgba("9+"));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_notification_click_opens_its_session_once() {
    use std::collections::HashMap;
    use zbus::message::Message;

    fn signal<B>(member: &str, body: &B) -> Message
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        Message::signal(
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
            member,
        )
        .unwrap()
        .build(body)
        .unwrap()
    }
    let shown = |session_id: &str| super::linux::Shown {
        session_id: session_id.to_string(),
        activation_token: None,
    };
    let sessions = Mutex::new(HashMap::from([
        (1, shown("clicked")),
        (2, shown("dismissed")),
        (3, shown("activated")),
    ]));
    let click = |id: u32| signal("ActionInvoked", &(id, "default"));

    assert_eq!(super::linux::clicked_session(&sessions, &click(7)), None);
    assert_eq!(
        super::linux::clicked_session(&sessions, &click(1)),
        Some(("clicked".to_string(), None))
    );
    assert_eq!(super::linux::clicked_session(&sessions, &click(1)), None);
    let closed = signal("NotificationClosed", &(2u32, 2u32));
    assert_eq!(super::linux::clicked_session(&sessions, &closed), None);
    assert_eq!(super::linux::clicked_session(&sessions, &click(2)), None);
    let token = signal("ActivationToken", &(3u32, "xdg-token"));
    assert_eq!(super::linux::clicked_session(&sessions, &token), None);
    assert_eq!(
        super::linux::clicked_session(&sessions, &click(3)),
        Some(("activated".to_string(), Some("xdg-token".to_string())))
    );
}
