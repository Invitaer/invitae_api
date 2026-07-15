import { validateSecrets } from './secrets.validator';

validateSecrets();

export const secrets = {
  PORT: process.env.PORT || '3000',
  NODE_ENV: process.env.NODE_ENV || 'development',

  POSTGRES_HOST: process.env.POSTGRES_HOST!,
  POSTGRES_PORT: process.env.POSTGRES_PORT!,
  POSTGRES_USER: process.env.POSTGRES_USER!,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD!,
  POSTGRES_DB: process.env.POSTGRES_DB!,
  DATABASE_URL: process.env.DATABASE_URL!,

  REDIS_HOST: process.env.REDIS_HOST!,
  REDIS_PORT: process.env.REDIS_PORT!,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD!,

  JWT_SECRET: process.env.JWT_SECRET!,

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL,
  FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
  FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
  FACEBOOK_CALLBACK_URL: process.env.FACEBOOK_CALLBACK_URL,

  DASHBOARD_URL: process.env.DASHBOARD_URL,
  USER_DASHBOARD_URL: process.env.USER_DASHBOARD_URL,

  WHATSAPP_API_URL: process.env.WHATSAPP_API_URL!,
  WHATSAPP_API_TOKEN: process.env.WHATSAPP_API_TOKEN!,
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET!,
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN!,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID!,

  SMS_API_URL: process.env.SMS_API_URL!,
  SMS_API_TOKEN: process.env.SMS_API_TOKEN!,

  MAIL_HOST: process.env.MAIL_HOST!,
  MAIL_PORT: process.env.MAIL_PORT!,
  MAIL_USER: process.env.MAIL_USER!,
  MAIL_PASS: process.env.MAIL_PASS!,
};