/**
 * Give one account an email + password log-in (everyone else signs in with Google only).
 * For the Meta / Google app-review test account, whose reviewer can't use your Google account.
 *
 *   npm run set-password -w server -- meta-review@crestclip.com 'a-strong-password'
 *
 * Makes the account if it doesn't exist yet (Free plan, with its first month's credits).
 * The reviewer then logs in at <PUBLIC_URL>/login?with=email
 */
import { closeDb, connectDb, users } from '../db/index.js';
import { refreshAccount } from '../modules/billing/billing.service.js';
import { hashPassword } from '../modules/auth/auth.service.js';

const [email = '', password = ''] = process.argv.slice(2).map((a) => a.trim());
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 12) {
  console.error("Usage: npm run set-password -w server -- EMAIL 'PASSWORD'   (password: at least 12 characters)");
  process.exit(1);
}

await connectDb();
const passwordHash = await hashPassword(password);
const found = await users.byEmail(email);
if (found) {
  await users.update(found.id, { passwordHash });
  console.log(`Password set for ${email}.`);
} else {
  await refreshAccount(await users.create({ email, name: 'App review', passwordHash }));
  console.log(`Made ${email} with that password.`);
}
console.log('Log in at /login?with=email');
await closeDb();
