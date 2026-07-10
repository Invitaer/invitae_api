import { validateSecrets } from './secrets.validator';

/**
 * Task 1.6 — validates that WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN and
 * WHATSAPP_PHONE_NUMBER_ID are enforced as required secrets.
 */
describe('validateSecrets — WhatsApp Meta secrets', () => {
  const BASE_REQUIRED_ENV = {
    POSTGRES_HOST: 'localhost',
    POSTGRES_PORT: '5432',
    POSTGRES_USER: 'user',
    POSTGRES_PASSWORD: 'pass',
    POSTGRES_DB: 'db',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    JWT_SECRET: 'jwt-secret',
    WHATSAPP_API_URL: 'https://graph.facebook.com',
    WHATSAPP_API_TOKEN: 'api-token',
    SMS_API_URL: 'https://sms.example.com',
    SMS_API_TOKEN: 'sms-token',
    MAIL_HOST: 'smtp.example.com',
    MAIL_PORT: '587',
    MAIL_USER: 'user',
    MAIL_PASS: 'pass',
  };

  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ...BASE_REQUIRED_ENV };
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('throws when WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN and WHATSAPP_PHONE_NUMBER_ID are missing', () => {
    expect(() => validateSecrets()).toThrow(/WHATSAPP_APP_SECRET/);
    expect(() => validateSecrets()).toThrow(/WHATSAPP_VERIFY_TOKEN/);
    expect(() => validateSecrets()).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
  });

  it('does not throw when all required secrets, including the WhatsApp Meta ones, are present', () => {
    process.env.WHATSAPP_APP_SECRET = 'app-secret';
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-number-id';

    expect(() => validateSecrets()).not.toThrow();
  });
});
