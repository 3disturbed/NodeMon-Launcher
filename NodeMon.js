const { exec, spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const nodemailer = require('nodemailer');

const SETTINGS_FILE = 'settings.json';
const REQUIRED_FILE = 'required.txt';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function createSettingsFile() {
  console.log("Settings file not found. Let's create one!");
  
  const settings = {
    repoOwner: await question("Enter the GitHub repository owner: "),
    repoName: await question("Enter the GitHub repository name: "),
    branch: await question("Enter the branch to monitor (default: main): ") || "main",
    checkIntervalSeconds: parseInt(await question("Enter the check interval in seconds (default: 60): ")) || 60,
    appFile: await question("Enter the main application file to run (default: index.js): ") || "index.js",
    notificationEmail: await question("Enter the email address for update notifications: "),
    smtpHost: await question("Enter the SMTP host for sending emails: "),
    smtpPort: parseInt(await question("Enter the SMTP port (default: 587): ")) || 587,
    smtpUser: await question("Enter the SMTP username: "),
    smtpPass: await question("Enter the SMTP password: "),
    localPath: await question("Enter the local path where the repository should be cloned (default: ./repo): ") || "./repo"
  };

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  console.log(`Settings saved to ${SETTINGS_FILE}`);
  return settings;
}

async function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return await createSettingsFile();
  }
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}

let settings;
let lastCommitSha = '';
let appProcess = null;

function getLatestCommit() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${settings.repoOwner}/${settings.repoName}/commits/${settings.branch}`,
      headers: {
        'User-Agent': 'Node.js'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const commit = JSON.parse(data);
          resolve(commit.sha);
        } else {
          reject(`GitHub API responded with status code ${res.statusCode}`);
        }
      });
    }).on('error', (e) => {
      reject(`Error: ${e.message}`);
    });
  });
}

function cloneRepository() {
  return new Promise((resolve, reject) => {
    const repoUrl = `https://github.com/${settings.repoOwner}/${settings.repoName}.git`;
    console.log(`Cloning repository from ${repoUrl}`);
    exec(`git clone -b ${settings.branch} ${repoUrl} ./`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error cloning repository: ${error}`);
        reject(error);
        return;
      }
      console.log(`Repository cloned successfully: ${stdout}`);
      if (stderr) console.error(`stderr: ${stderr}`);
      resolve();
    });
  });
}

function pullChanges() {
  return new Promise((resolve, reject) => {
    exec(`git -C ${settings.localPath} pull origin ${settings.branch}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error pulling changes: ${error}`);
        reject(error);
        return;
      }
      console.log(`Changes pulled successfully: ${stdout}`);
      if (stderr) console.error(`stderr: ${stderr}`);
      resolve(stdout);
    });
  });
}

function installDependencies() {
  return new Promise((resolve, reject) => {
    const requiredFilePath = path.join(settings.localPath, REQUIRED_FILE);
    if (!fs.existsSync(requiredFilePath)) {
      console.log('No required.txt file found. Skipping dependency installation.');
      resolve('No new dependencies.');
      return;
    }

    const modules = fs.readFileSync(requiredFilePath, 'utf8').split('\n').filter(module => module.trim() !== '');
    
    if (modules.length === 0) {
      console.log('required.txt is empty. Skipping dependency installation.');
      resolve('No new dependencies.');
      return;
    }

    console.log('Installing dependencies...');
    exec(`cd ${settings.localPath} && npm install ${modules.join(' ')}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error installing dependencies: ${error}`);
        reject(error);
        return;
      }
      console.log(`Dependencies installed successfully: ${stdout}`);
      if (stderr) console.error(`stderr: ${stderr}`);
      resolve(`Installed dependencies: ${modules.join(', ')}`);
    });
  });
}

function startApp() {
  if (appProcess) {
    console.log('App is already running');
    return;
  }
  
  console.log(`Starting ${settings.appFile}...`);
  // change working directory to the app directory
  process.chdir(settings.localPath);

  appProcess = spawn('node', [settings.appFile], { stdio: 'inherit' });
  
  appProcess.on('close', (code) => {
    console.log(`Child process exited with code ${code}`);
    appProcess = null;
  });
}

function stopApp() {
  return new Promise((resolve) => {
    if (!appProcess) {
      console.log('No app is currently running');
      resolve();
      return;
    }

    console.log('Stopping the app...');
    appProcess.kill();
    appProcess.on('close', () => {
      console.log('App stopped');
      appProcess = null;
      resolve();
    });
  });
}

async function sendEmail(subject, body) {
  let transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465, // true for 465, false for other ports
    auth: {
      user: settings.smtpUser,
      pass: settings.smtpPass,
    },
  });

  let info = await transporter.sendMail({
    from: `"GitHub Monitor" <${settings.smtpUser}>`,
    to: settings.notificationEmail,
    subject: subject,
    text: body,
  });

  console.log(`Email sent: ${info.messageId}`);
}

async function checkForChanges() {
  try {
    const latestCommitSha = await getLatestCommit();
    if (latestCommitSha !== lastCommitSha) {
      console.log('New commit detected. Pulling changes...');
      await stopApp();
      const pullResult = await pullChanges();
      const dependenciesResult = await installDependencies();
      startApp();
      lastCommitSha = latestCommitSha;

      // Send email notification
      const subject = `Update Notification: ${settings.repoName}`;
      const body = `
        An update has been applied to ${settings.repoName}.

        Changes:
        ${pullResult}

        Dependencies:
        ${dependenciesResult}

        The application has been restarted.
      `;
      await sendEmail(subject, body);
    } else {
      console.log('No new changes detected.');
      if (!appProcess) {
        startApp();
      }
    }
  } catch (error) {
    console.error(`Error checking for changes: ${error}`);
  }
}

async function main() {
  settings = await loadSettings();
  rl.close();

  // Check if repository exists locally, if not, clone it
  if (!fs.existsSync(settings.localPath)) {
    console.log(`Repository not found at ${settings.localPath}`);
    try {
      await cloneRepository();
    } catch (error) {
      console.error(`Failed to clone repository: ${error}`);
      process.exit(1);
    }
  }

  // Initial check and start
  checkForChanges();

  // Set up periodic checking
  setInterval(checkForChanges, settings.checkIntervalSeconds * 1000);

  console.log(`Monitor started. Checking for changes every ${settings.checkIntervalSeconds} seconds.`);
}

main();
