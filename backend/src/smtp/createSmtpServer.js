const fs = require("fs");
const { SMTPServer } = require("smtp-server");

function loadTlsCerts(config) {
  try {
    const keyPath = config.TLS_KEY_PATH;
    const certPath = config.TLS_CERT_PATH;
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    }
  } catch (e) {
    // Certs not available – STARTTLS will be unavailable
  }
  return {};
}

function createSmtpServer({ config, processIncomingEmail, addLog }) {
  const tlsCerts = loadTlsCerts(config);

  const smtpServer = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH"],
    secure: false,
    ...tlsCerts,

    onConnect(session, callback) {
      addLog("info", "SMTP connection", { ip: session.remoteAddress });
      callback();
    },

    onRcptTo(address, session, callback) {
      const email = address.address.toLowerCase();
      const domain = email.split("@")[1];

      if (domain === config.EMAIL_DOMAIN) {
        callback();
      } else {
        callback(new Error(`We don't accept mail for ${domain}`));
      }
    },

    onData(stream, session, callback) {
      let emailData = "";

      stream.on("data", (chunk) => {
        emailData += chunk;
      });

      stream.on("end", async () => {
        try {
          await processIncomingEmail({ emailData, session });
          callback();
        } catch (error) {
          addLog("error", "Error processing incoming email", {
            error: error.message,
          });
          callback(new Error("Error processing email"));
        }
      });
    },
  });

  smtpServer.on("error", (err) => {
    addLog("error", "SMTP server error", { error: err.message });
  });

  return smtpServer;
}

module.exports = {
  createSmtpServer,
};
