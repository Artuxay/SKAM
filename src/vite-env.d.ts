interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Старое имя переменной — тоже поддерживается. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Длина кода из письма (Supabase → Auth → Email OTP length), по умолчанию 8. */
  readonly VITE_EMAIL_OTP_LENGTH?: string;
  /** Длина кода из SMS, по умолчанию 6. */
  readonly VITE_SMS_OTP_LENGTH?: string;
  /**
   * Необязательный TURN-сервер для звонков (через запятую, например turn:turn.example.com:3478,turns:turn.example.com:5349).
   * Без него звонки идут напрямую; в сетях, где напрямую не пробиться (некоторые мобильные операторы), нужен TURN.
   */
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
