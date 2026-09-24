interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Старое имя переменной — тоже поддерживается. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Длина кода из письма (Supabase → Auth → Email OTP length), по умолчанию 8. */
  readonly VITE_EMAIL_OTP_LENGTH?: string;
  /** Длина кода из SMS, по умолчанию 6. */
  readonly VITE_SMS_OTP_LENGTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
