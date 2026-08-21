# Mind Vault SMS OTP setup

Mind Vault now supports phone OTP for registration and phone-OTP sign-in through Twilio Verify.

## Required server environment variables

Set these in the server deployment environment (do not commit secrets):

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_VERIFY_SERVICE_SID`

Also configure `JWT_SECRET` and `CLIENT_ORIGIN`.

## Flow

1. Register: enter phone number -> send SMS OTP -> verify code -> create account.
2. Login: choose `Sign in with phone OTP` -> enter phone -> send OTP -> enter code -> sign in.
3. Phone numbers are normalized to E.164; a 10-digit Indian number is accepted as `+91...`.
4. OTPs are rate-limited per phone/purpose and expire after 10 minutes.

## Deployment

Add the three Twilio variables to Vercel/Netlify/Firebase Functions server environment variables. The app intentionally does not contain SMS credentials.
