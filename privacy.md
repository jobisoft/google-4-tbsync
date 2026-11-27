# Privacy policy

Last updated: 2026-11-27

Google-4-TbSync synchronizes contacts and contact groups between Thunderbird and the user's Google account, through Google's People API. The developer runs no server for it and receives no data. It has no telemetry, analytics or advertising.

## Data and transmission

After the user adds an account and signs in, the add-on sends contacts and contact groups (names, email addresses, telephone numbers, addresses, notes and other contact fields) and OAuth tokens only to Google, at `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` and `people.googleapis.com`. The sign-in happens on Google's own page, and the add-on never sees the Google password. It requests the `contacts` and `userinfo.email` scopes, and reads the account's email address to show which account is connected. Google's privacy policy applies to the data held there.

No other host is contacted, and no remote code is loaded.

## Local storage

The user's own Google Cloud OAuth client ID and secret, the OAuth refresh token, the account's email address and synchronization state are stored in the add-on's `storage.local` in the Thunderbird profile. Credentials are stored unencrypted. Technical messages go to the local TbSync event log, which is never sent anywhere automatically.

## User control

The user can disable or delete an account at any time in TbSync, and uninstalling the add-on removes its stored data. Access can also be revoked at <https://myaccount.google.com/permissions>.

## Contact

<https://github.com/jobisoft/google-4-tbsync/issues>
