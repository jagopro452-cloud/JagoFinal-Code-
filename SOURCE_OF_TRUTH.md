## JAGO Source Of Truth

Use this folder structure as the official working source:

- Git/deploy wrapper root: `jago_app-main/`
- Real application source: `jago_app-main/app/`

Important:

- The `app/` folder contains the actual `client/`, `server/`, and `flutter_apps/` code used for builds.
- The outer root exists on purpose for deployment and script delegation.
- Do not delete the outer root or flatten the folders without updating deployment config first.

Recommended working directory:

`C:\Users\kiran\Downloads\jago-Updates-23-04-jago\jago-Updates-23-04-jago\jago_app-main\app`
