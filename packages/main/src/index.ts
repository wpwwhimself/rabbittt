import {app, BrowserWindow, ipcMain, ipcRenderer, protocol, session, shell} from 'electron';
import './security-restrictions';
import {restoreOrCreateWindow} from '/@/mainWindow';
import {platform} from 'node:process';
import * as path from 'node:path';
import * as fs from 'fs';
import * as sqlite3 from 'sqlite3';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as http from "http";
import * as url from "url";

/**
 * Prevent electron from running multiple instances.
 */
const isSingleInstance = app.requestSingleInstanceLock();
if (!isSingleInstance) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', restoreOrCreateWindow);

/**
 * Disable Hardware Acceleration to save more system resources.
 */
app.disableHardwareAcceleration();

/**
 * Shout down background process if all windows was closed
 */
app.on('window-all-closed', () => {
  if (platform !== 'darwin') {
    app.quit();
  }
});

/**
 * @see https://www.electronjs.org/docs/latest/api/app#event-activate-macos Event: 'activate'.
 */
app.on('activate', restoreOrCreateWindow);

/**
 * *CREATE DATABASE*
 * check the existence of sqlite database
 * and create one, if empty
 */
const dbPath = path.join(__dirname, "../../../database.db");

if(!fs.existsSync(dbPath)){
  fs.closeSync(fs.openSync(dbPath, 'w'));
}
/**
 * then populate the database with tables
 */
const db = new sqlite3.Database(dbPath);
const queries = [
  `CREATE TABLE IF NOT EXISTS students(
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT,
    price REAL,
    phone TEXT,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL,
    session_date TEXT DEFAULT CURRENT_DATE NOT NULL,
    duration REAL,
    price REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY(student_id) REFERENCES students(id)
  )`,
  `CREATE TABLE IF NOT EXISTS settings(
    name TEXT PRIMARY KEY,
    desc TEXT NOT NULL,
    value TEXT
  )`,
  `INSERT OR IGNORE INTO settings VALUES
    ("default_student_price", "Domyślna stawka [zł]", 50),
    ("default_session_duration", "Domyślna długość sesji [h]", 1),
    ("price_factor_below_1", "Mnożnik stawki dla sesji poniżej 1 h", 1.0666667),
    ("student_inactive_days", "Powyżej ilu dni braku wpisów uczeń jest uznawany za nieaktywnego", 60),
    ("accent_color", "Kolor wiodący aplikacji", "256, 69%, 69%"),
    ("dark_mode", "Tryb ciemny", 0)
  `,
];
db.serialize(() => {
  for(let query of queries){
    db.all(query, [], (err, rows) => {
      if(err){
        console.error(err);
        return;
      }
    });
  }
});
db.close();

/**
 * Create the application window when the background process is ready.
 */
app
  .whenReady()
  .then(restoreOrCreateWindow)
  .catch(e => console.error('Failed create window:', e));

/**
 * Install Vue.js or any other extension in development mode only.
 * Note: You must install `electron-devtools-installer` manually
 */
// if (import.meta.env.DEV) {
//   app
//     .whenReady()
//     .then(() => import('electron-devtools-installer'))
//     .then(module => {
//       const {default: installExtension, VUEJS3_DEVTOOLS} =
//         // @ts-expect-error Hotfix for https://github.com/cawa-93/vite-electron-builder/issues/915
//         typeof module.default === 'function' ? module : (module.default as typeof module);
//
//       return installExtension(VUEJS3_DEVTOOLS, {
//         loadExtensionOptions: {
//           allowFileAccess: true,
//         },
//       });
//     })
//     .catch(e => console.error('Failed install extension:', e));
// }

/**
 * Check for app updates, install it in background and notify user that new version was installed.
 * No reason run this in non-production build.
 * @see https://www.electron.build/auto-update.html#quick-setup-guide
 *
 * Note: It may throw "ENOENT: no such file app-update.yml"
 * if you compile production app without publishing it to distribution server.
 * Like `npm run compile` does. It's ok 😅
 */
if (import.meta.env.PROD) {
  app
    .whenReady()
    .then(() =>
      /**
       * Here we forced to use `require` since electron doesn't fully support dynamic import in asar archives
       * @see https://github.com/electron/electron/issues/38829
       * Potentially it may be fixed by this https://github.com/electron/electron/pull/37535
       */
      require('electron-updater').autoUpdater.checkForUpdatesAndNotify(),
    )
    .catch(e => console.error('Failed check and install updates:', e));
}

/**
 * google auth
 */
const CALLBACK_PORT = 9876;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/google-auth`;
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_PATH = "TOKEN.json";

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 */
interface Authorize {
  (
    client_id: string,
    client_secret: string,
    redirect_uri: string,
    callback: (...args: any[]) => any,
  ): any
}
const authorize: Authorize = function(client_id, client_secret, redirect_uri, callback){
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uri
  );

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
      if (err) return getNewToken(oAuth2Client, callback);
      oAuth2Client.setCredentials(JSON.parse(token.toString()));
      callback(oAuth2Client);
  });
}

/**
* Get and store new token after prompting for user authorization, and then
* execute the given callback with the authorized OAuth2 client.
*/
interface GetNewToken{
  (
    oAuth2Client: OAuth2Client,
    callback: (...args: any[]) => any,
  ): any
}
const getNewToken: GetNewToken = function (oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
  });

  // Create auth prompt
  let win = createAuthPrompt(authUrl);

  // Create a temp server for receiving the authentication approval request
  const server = http.createServer(function (req, res) {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end("OK. Autoryzacja pomyślna, możesz zamknąć tę kartę.");

      var q = url.parse(req.url!, true).query;
      const code = q.code as string;
      if(!code) return;

      oAuth2Client.getToken(code, (err, token) => {
          if (err) return console.error('Error while trying to retrieve access token', err);
          oAuth2Client.setCredentials(token!);

          // Store the token to disk for later program executions
          fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
              if (err) return console.error(err);
              console.log('Token stored to', TOKEN_PATH);
          });

          // Close the auth window (if it was an electron window) and stop the server
          // if(win) win.close();
          server.close( err => {
              if(err) return console.log(err)
              console.log("Server closed")
          });

          callback(oAuth2Client);
      });
  });
  server.listen(CALLBACK_PORT);
}

function createAuthPrompt(authUrl: string) {
  shell.openExternal(authUrl);
}

ipcMain.on("calendar", (event, func) => {
  authorize(
    import.meta.env.VITE_GOOGLE_API_CLIENT_ID,
    import.meta.env.VITE_GOOGLE_API_CLIENT_SECRET,
    REDIRECT_URI,
    func
  );
})

ipcMain.on("calendar-events", (event, auth) => {
  const calendar = google.calendar({ version: 'v3', auth });
  calendar.calendarList.get({

  }, (err, res) => {
    if (err) return console.log('The API returned an error: ' + err);
    console.log(res);
  });
})
