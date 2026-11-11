const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const config = require('./config/env');
const { notFound, errorHandler, authed, requireAdmin } = require('./middleware');

const signupRoute = require('./routes/signup');
const loginRoute = require('./routes/login');
const userDataRoute = require('./routes/userData');
const fundRoute = require('./routes/fundwallet');
const airtimeRoute = require('./routes/buyairtime');
const dataRoute = require('./routes/buydata');
const buyepinRoute = require('./routes/BuyEpin');
const wenbookRoute = require('./routes/wenbook');
const atcRoute = require('./routes/atoc');
const setupRoute = require('./routes/setup');
const cablesRoute = require('./routes/cables');
const authRoute = require('./routes/auth');
const electricRoute = require('./routes/electricity');
const storeRoute = require('./routes/store');
const catalogRoute = require('./routes/catalog');
const ledgersRoute = require('./routes/ledgers');
const purchasesRoute = require('./routes/purchases');
const ordersRoute = require('./routes/orders');
const walletRoute = require('./routes/wallet');
const profileRoute = require('./routes/profile');
const adminCatalogRoute = require('./routes/admin/catalog');
const adminStatsRoute = require('./routes/admin/stats');
const adminUsersRoute = require('./routes/admin/users');
const adminTransactionsRoute = require('./routes/admin/transactions');
const adminProvidersRoute = require('./routes/admin/providers');
const adminRequeryRoute = require('./routes/admin/requery');
const adminAtcOrdersRoute = require('./routes/admin/atc-orders');
const adminProviderCatalogRoute = require('./routes/admin/provider-catalog');
const adminEarningsRoute = require('./routes/admin/earnings');
const adminImportRoute = require('./routes/admin/import');
const adminWaitlistRoute = require('./routes/admin/waitlist');

const app = express();

app.use(
  cors(
    config.corsOrigins.length ? { origin: config.corsOrigins } : undefined
  )
);

// The Paystack webhook needs the unparsed body to verify its signature, so it
// is mounted before the JSON parser.
app.use('/wenbook', express.raw({ type: '*/*' }), wenbookRoute);

app.use(bodyParser.json({ limit: '100kb' }));

app.get('/', (req, res) => {
  res.json({ message: 'Swiftza API is working' });
});

// Public: credentials are the entry point, and the installer runs before any
// account exists. /wenbook is mounted above and authenticates by HMAC instead.
app.use('/signup', signupRoute);
app.use('/login', loginRoute);
app.use('/setup', setupRoute);

// Anything that spends money or reads a profile. `authed` also rewrites
// req.body.uid from the session, so the caller cannot act as another user.
app.use('/userData', authed, userDataRoute);
app.use('/electricity', authed, electricRoute);
app.use('/buyepin', authed, buyepinRoute);
app.use('/fundwallet', authed, fundRoute);
app.use('/airtime', authed, airtimeRoute);
app.use('/data', authed, dataRoute);
app.use('/cables', authed, cablesRoute);
app.use('/atc', authed, atcRoute);

// Mixed — these mount their own per-endpoint guards.
app.use('/store', storeRoute);
app.use('/auth', authRoute);

// --- New customer contract (samzeenuxt). Runs alongside the legacy routes
// above until samzeedatas is retired, then those are deleted.
app.use('/catalog', catalogRoute);
app.use('/', ledgersRoute);
app.use('/', purchasesRoute);
app.use('/', ordersRoute);
app.use('/', walletRoute);
app.use('/', profileRoute);

// --- Admin. requireAdmin re-reads the role from the database rather than
// trusting the JWT claim, so revoking an admin takes effect immediately.
app.use('/admin', requireAdmin, adminCatalogRoute);
app.use('/admin', requireAdmin, adminStatsRoute);
app.use('/admin', requireAdmin, adminUsersRoute);
app.use('/admin', requireAdmin, adminTransactionsRoute);
app.use('/admin', requireAdmin, adminProvidersRoute);
app.use('/admin', requireAdmin, adminRequeryRoute);
app.use('/admin', requireAdmin, adminAtcOrdersRoute);
app.use('/admin', requireAdmin, adminProviderCatalogRoute);
app.use('/admin', requireAdmin, adminEarningsRoute);
app.use('/admin', requireAdmin, adminImportRoute);
app.use('/admin', requireAdmin, adminWaitlistRoute);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
