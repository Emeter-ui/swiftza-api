const config = require('./src/config/env');
const mongo = require('./src/services/mongo');
const { finance } = require('./src/models/finance');
const app = require('./src/app');

// Connect, index and probe once per process. On Vercel a "process" is a warm
// function instance, so this runs on each cold start and every later request
// on that instance reuses the same connection. A failed boot is forgotten
// rather than cached, so the next request retries instead of the instance
// failing every request until Vercel recycles it.
let ready = null;

function boot() {
  if (!ready) {
    ready = (async () => {
      await mongo.connect(config.mongo.uri(), config.mongo.dbName);
      await mongo.ensureIndexes();
      await mongo.assertTransactionsAvailable();

      // A PENDING wallet row only ever moves off that status inside the request
      // that created it (purchase.js) -- a restart is exactly what interrupts
      // that, and is exactly what this recovers from. Deliberately a one-shot
      // startup sweep rather than a scheduler: the failure it exists to fix is a
      // process restart, which this runs on every time by construction. It only
      // touches rows pending for over STALE_PENDING_SWEEP_MS (an hour), longer
      // than any request can run, so a cold start cannot sweep a purchase that
      // another instance is still completing.
      //
      // Fault-isolated from connect/ensureIndexes/assertTransactionsAvailable ON
      // PURPOSE, unlike those: a bad MONGODB_URI must fail boot rather than serve
      // 500s on every request, but this sweep is a best-effort recovery step, not
      // a precondition for serving traffic. A transient write conflict on one
      // row, or a Mongo hiccup in the seconds right after a restart -- exactly
      // the condition this sweep exists to recover from -- must not itself take
      // the whole API down. On failure the rows simply stay PENDING and the next
      // boot's sweep retries them.
      try {
        const { swept, found } = await finance.sweepStalePending({});
        console.log(`[boot] stale-pending sweep: moved ${swept} of ${found} found row(s) into requery`);
      } catch (err) {
        console.error(
          '[boot] stale-pending sweep FAILED -- continuing to start without it. ' +
          'Any stale PENDING rows were NOT moved to requery this boot and will be retried next boot:',
          err
        );
      }
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

// Vercel's Node runtime requires this module to export a handler. Requests
// wait for boot, because every route assumes the database is connected.
async function handler(req, res) {
  try {
    await boot();
  } catch (err) {
    console.error('[boot] failed to start:', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'error',
      code: 'SERVICE_UNAVAILABLE',
      msg: 'Service is starting up or unavailable. Please try again.',
    }));
    return;
  }
  return app(req, res);
}

// Anywhere but Vercel (node, nodemon, pm2) this is a long-running server.
// Checked by environment rather than require.main, because pm2 loads this file
// through its own container, so require.main is never this module under pm2.
// Connecting before listening means a bad MONGODB_URI kills the process at
// boot with a clear error, rather than serving 500s on every request.
if (!process.env.VERCEL) {
  boot()
    .then(() => {
      app.listen(config.port, () => {
        console.log(`Server started on port ${config.port} (${config.nodeEnv})`);
      });
    })
    .catch((err) => {
      console.error('[boot] failed to start:', err);
      process.exit(1);
    });
}

module.exports = handler;
