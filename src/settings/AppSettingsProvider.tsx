import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  defaultAppSettings,
  getAppSettings,
  updateAppSettings,
  type AppSettings,
} from "../data/settingsApi";
import { resolveAppLanguage } from "../i18n/language";
import { translations } from "../i18n/translations";
import { dismissNotification, notifyError } from "../notifications";

export type AppSettingsPatch =
  Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>);

type AppSettingsContextValue = {
  settings: AppSettings;
  updateSettings: (patch: AppSettingsPatch) => Promise<AppSettings>;
};

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

const settingsLoadNotificationKey = "settings-load";

// Runs outside I18nProvider, before the saved language is known.
function notifySettingsLoadError() {
  const language = resolveAppLanguage(
    defaultAppSettings.languagePreference,
    window.navigator.languages?.[0] ?? window.navigator.language,
  );
  notifyError(translations[language]["settings.loadError"], {
    key: settingsLoadNotificationKey,
  });
}

type AppSettingsProviderProps = {
  children: ReactNode;
};

export function AppSettingsProvider({ children }: AppSettingsProviderProps) {
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const loadedSettingsRef = useRef<AppSettings | null>(null);
  const [settingsLoadBarrier] = useState(() => {
    let resolveSettingsLoad!: (settings: AppSettings | null) => void;
    const promise = new Promise<AppSettings | null>((resolve) => {
      resolveSettingsLoad = resolve;
    });

    return { promise, resolve: resolveSettingsLoad };
  });
  const initialSettingsRequestRef = useRef<Promise<AppSettings> | null>(null);
  const updateQueueRef = useRef<Promise<AppSettings | null>>(
    settingsLoadBarrier.promise,
  );

  useEffect(() => {
    let isMounted = true;

    if (!initialSettingsRequestRef.current) {
      initialSettingsRequestRef.current = getAppSettings();
    }

    void initialSettingsRequestRef.current.then(
      (loadedSettings) => {
        if (!isMounted) {
          return;
        }

        loadedSettingsRef.current = loadedSettings;
        setSettings(loadedSettings);
        settingsLoadBarrier.resolve(loadedSettings);
      },
      () => {
        if (isMounted) {
          notifySettingsLoadError();
          settingsLoadBarrier.resolve(null);
        }
      },
    );

    return () => {
      isMounted = false;
    };
  }, [settingsLoadBarrier]);

  const updateSettings = useCallback((patch: AppSettingsPatch) => {
    const update = updateQueueRef.current
      .catch(() => loadedSettingsRef.current)
      .then(async (currentSettings) => {
        if (!currentSettings) {
          currentSettings = await getAppSettings();
          loadedSettingsRef.current = currentSettings;
          setSettings(currentSettings);
          dismissNotification(settingsLoadNotificationKey);
        }

        const nextSettings: AppSettings = {
          ...currentSettings,
          ...(typeof patch === "function" ? patch(currentSettings) : patch),
        };
        const updatedSettings = await updateAppSettings(nextSettings);

        loadedSettingsRef.current = updatedSettings;
        setSettings(updatedSettings);

        return updatedSettings;
      });

    updateQueueRef.current = update.catch(() => loadedSettingsRef.current);

    return update;
  }, []);

  const value = useMemo<AppSettingsContextValue>(
    () => ({
      settings,
      updateSettings,
    }),
    [settings, updateSettings],
  );

  return (
    <AppSettingsContext.Provider value={value}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  const value = useContext(AppSettingsContext);

  if (!value) {
    throw new Error("useAppSettings must be used within AppSettingsProvider");
  }

  return value;
}
