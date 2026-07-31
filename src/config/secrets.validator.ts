interface SecretConfig {
  name: string;
  required: boolean;
}

const SECRETS: SecretConfig[] = [
  { name: 'POSTGRES_HOST', required: true },
  { name: 'POSTGRES_PORT', required: true },
  { name: 'POSTGRES_USER', required: true },
  { name: 'POSTGRES_PASSWORD', required: true },
  { name: 'POSTGRES_DB', required: true },
  { name: 'DATABASE_URL', required: true },
  { name: 'REDIS_HOST', required: true },
  { name: 'REDIS_PORT', required: true },
  { name: 'JWT_SECRET', required: true },
  { name: 'WHATSAPP_API_URL', required: true },
  { name: 'WHATSAPP_API_TOKEN', required: true },
  { name: 'WHATSAPP_APP_SECRET', required: true },
  { name: 'WHATSAPP_VERIFY_TOKEN', required: true },
  { name: 'WHATSAPP_PHONE_NUMBER_ID', required: true },
  { name: 'SMS_API_URL', required: true },
  { name: 'SMS_API_TOKEN', required: true },
  { name: 'MAIL_HOST', required: true },
  { name: 'MAIL_PORT', required: true },
  { name: 'MAIL_USER', required: true },
  { name: 'MAIL_PASS', required: true },
  { name: 'MAIL_FROM', required: false },
  { name: 'GOOGLE_CLIENT_ID', required: false },
  { name: 'GOOGLE_CLIENT_SECRET', required: false },
  { name: 'GOOGLE_CALLBACK_URL', required: false },
  { name: 'FACEBOOK_APP_ID', required: false },
  { name: 'FACEBOOK_APP_SECRET', required: false },
  { name: 'FACEBOOK_CALLBACK_URL', required: false },
];

export function validateSecrets(): void {
  const missing: string[] = [];
  const empty: string[] = [];

  for (const secret of SECRETS) {
    const value = process.env[secret.name];

    if (!value) {
      if (secret.required) {
        missing.push(secret.name);
      }
    } else if (secret.required && value.trim() === '') {
      empty.push(secret.name);
    }
  }

  if (missing.length > 0 || empty.length > 0) {
    const errors: string[] = [];

    if (missing.length > 0) {
      errors.push(`Missing required secrets: ${missing.join(', ')}`);
    }

    if (empty.length > 0) {
      errors.push(`Empty required secrets: ${empty.join(', ')}`);
    }

    throw new Error(`\n\nSecrets validation failed:\n${errors.join('\n')}`);
  }

  console.log('All secrets validated successfully');
}