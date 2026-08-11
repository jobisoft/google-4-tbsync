# Google-4-TbSync

This provider add-on adds Google synchronization capabilities to [TbSync](https://github.com/jobisoft/TbSync).

Only contacts and contact groups are managed, using Google's People API. There is no plan to support calendars.

## Maintainership

Google-4-TbSync was created by Marco Zanon at [zanonmark/Google-4-TbSync](https://github.com/zanonmark/Google-4-TbSync) and is now continued here by [John Bieling](https://github.com/jobisoft). Issues and questions belong in this repository.

## Modern TbSync

v5.2.x is a rewrite for modern TbSync, and requires Thunderbird 153 or newer. Like TbSync itself, the goal of the rewrite is to be a modern WebExtension: the setup and settings dialogs are HTML instead of XUL, and the only legacy code left is what migrates accounts from earlier versions.

TbSync v5.2.\* only works with provider add-ons from the modern v5.2.\* family, so update all parts together.

What it syncs is unchanged, with one addition: Thunderbird-to-Google contact group membership, which earlier versions had to leave out until the port to WebExtensions was done.

## What works

* Google-to-Thunderbird creation / update / deletion of contacts;
* Google-to-Thunderbird creation / update / deletion of contact groups;
* Google-to-Thunderbird creation / update / deletion of contact group members;
* Thunderbird-to-Google creation / update / deletion of contacts;
* Thunderbird-to-Google creation / update / deletion of contact groups;
* Thunderbird-to-Google creation / update / deletion of contact group members.

## How to use it

You first need to install a matching build of [TbSync](https://github.com/jobisoft/TbSync/releases) and generate your own Google Cloud Console project credentials. Set them up as a **Web OAuth client**: the desktop client type earlier versions used is deprecated by Google, and existing ones may keep working, but new credentials should be web clients. [How to generate your own Google Cloud Console project credentials](https://github.com/jobisoft/google-4-tbsync/wiki/How-to-generate-your-own-Google-Cloud-Console-project-credentials) walks through it, including the redirect URL you have to authorize.

Then install this add-on. .xpi packages are published on this repository's [releases page](https://github.com/jobisoft/google-4-tbsync/releases).

## Warning

* **Do regular backups of both your Google and Thunderbird address books.**
* The _Read-only mode_ option is there for when you want Google to be the only side that changes.
