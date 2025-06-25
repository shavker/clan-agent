// webhook.js
require('dotenv').config();
const crypto      = require('crypto');
const express     = require('express');
const { exec }    = require('child_process');

const app     = express();
const port    = process.env.WEBHOOK_PORT || 3000;
const secret  = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error('❌ WEBHOOK_SECRET не задан в .env');
  process.exit(1);
}

// Для проверки подписи нам нужен доступ к "сырым" байтам тела запроса
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
}));

app.post('/webhook', (req, res) => {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return res.status(403).send('No signature');

  const hmac = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  if (`sha256=${hmac}` !== sig) {
    console.warn('⚠️ Bad signature:', sig);
    return res.status(403).send('Invalid signature');
  }

  const event = req.headers['x-github-event'];
  if (event !== 'push') return res.status(200).send('Ignored event');

  const branch = req.body.ref.replace('refs/heads/', '');
  if (branch !== 'main') return res.status(200).send('Ignored branch');

  console.log('✅ Webhook: pull & restart on main');

  exec(
    'cd /root/clan-agent && git pull origin main && pm2 restart clan-agent',
    (err, stdout, stderr) => {
      if (err) {
        console.error('❌ Deploy error:', stderr);
        return res.status(500).send('Deploy failed');
      }
      console.log('✅ Deploy success:', stdout);
      res.send('OK');
    }
  );
});

app.listen(port, () => {
  console.log(`🔔 Webhook listener started on port ${port}`);
});
