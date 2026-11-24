// The customer app (swiftza-web-app) as the assistant sees it. The model may
// only send the user to a route listed here, and only with the params listed
// for it -- anything else it invents is dropped server-side. Keep this in
// step with swiftza-web-app/app/pages: a route the app does not have would
// navigate to a 404, and a param a page does not read would silently do
// nothing.
//
// `group` is what the admin toggles on and off under AI settings.

const ROUTES = [
  // ── Home & wallet ────────────────────────────────────────────────────────
  { route: '/dashboard', group: 'general', title: 'Home', description: 'Dashboard with wallet balance, quick actions and recent activity.' },
  { route: '/dashboard/services', group: 'general', title: 'All services', description: 'Grid of every bill and top-up service.' },
  { route: '/dashboard/wallet', group: 'wallet', title: 'Wallet', description: 'Balance and wallet history: every credit (top-ups, refunds) and debit (purchases).' },
  {
    route: '/dashboard/wallet/fund', group: 'wallet', title: 'Add money',
    description: 'Top up the wallet with Paystack. Shows the funding fee for the amount before paying.',
    params: { amount: 'whole naira amount to add', method: 'card | transfer | ussd (only card is live)' },
  },

  // ── Purchases (user still confirms and enters their PIN) ─────────────────
  {
    route: '/dashboard/buy/airtime', group: 'purchases', title: 'Buy airtime',
    description: 'Airtime top-up for MTN, Airtel, Glo, 9mobile. Minimum ₦100.',
    params: { network: 'network name exactly as in the catalog', phone: '11-digit Nigerian number', amount: 'whole naira amount' },
  },
  {
    route: '/dashboard/buy/data', group: 'purchases', title: 'Buy data',
    description: 'Data bundles by network and plan type (SME, GIFTING, CORPORATE).',
    params: { network: 'network name', phone: '11-digit number', planId: 'data plan id from the catalog', planType: 'SME | GIFTING | CORPORATE' },
  },
  {
    route: '/dashboard/buy/cable', group: 'purchases', title: 'Cable TV',
    description: 'DStv, GOtv, Startimes subscriptions. Verifies the smartcard/IUC number first.',
    params: { provider: 'cable provider name', smartcard: 'smartcard / IUC number', planId: 'cable plan id from the catalog' },
  },
  {
    route: '/dashboard/buy/electricity', group: 'purchases', title: 'Electricity',
    description: 'Prepaid or postpaid meter payment for a disco. Verifies the meter first; prepaid returns a token.',
    params: { disco: 'disco name', meterType: 'prepaid | postpaid', meter: 'meter number', amount: 'whole naira amount' },
  },
  {
    route: '/dashboard/buy/exam', group: 'purchases', title: 'Exam pins',
    description: 'WAEC, NECO, NABTEB result-checker pins.',
    params: { provider: 'exam name', quantity: 'number of pins, 1-10' },
  },
  {
    route: '/dashboard/buy/betting', group: 'purchases', title: 'Betting wallet',
    description: 'Fund a betting account by user ID.',
    params: { provider: 'betting provider name', userId: 'betting account user id', amount: 'whole naira amount' },
  },

  // ── History ──────────────────────────────────────────────────────────────
  {
    route: '/dashboard/transactions', group: 'transactions', title: 'Transactions',
    description: 'All purchases, filterable by kind (airtime, data, cable, electricity, epin, wallet).',
    params: { kind: 'airtime | data | cable | electricity | epin | wallet' },
  },
  {
    route: '/dashboard/transactions/:id', group: 'transactions', title: 'Receipt',
    description: 'Receipt for one transaction. :id is the transaction id from the user\'s history.',
    pathParams: ['id'],
  },

  // ── Account ──────────────────────────────────────────────────────────────
  { route: '/dashboard/profile', group: 'profile', title: 'Profile', description: 'Account menu.' },
  { route: '/dashboard/profile/personal', group: 'profile', title: 'Personal details', description: 'Name, email, phone.' },
  { route: '/dashboard/profile/security', group: 'profile', title: 'Security', description: 'Password, PIN and sign-in options.' },
  { route: '/dashboard/profile/change-password', group: 'profile', title: 'Change password', description: 'Change the login password.' },
  { route: '/dashboard/profile/change-pin', group: 'profile', title: 'Change PIN', description: 'Change the 4-digit transaction PIN.' },
  { route: '/dashboard/profile/favorites', group: 'profile', title: 'Saved beneficiaries', description: 'Saved numbers, meters and smartcards.' },
  { route: '/dashboard/profile/notifications', group: 'profile', title: 'Notifications', description: 'Notification preferences.' },
  { route: '/dashboard/profile/invite', group: 'profile', title: 'Invite friends', description: 'Referral link.' },

  // ── Help ─────────────────────────────────────────────────────────────────
  { route: '/dashboard/profile/help', group: 'support', title: 'Help center', description: 'FAQs and guides.' },
  { route: '/dashboard/profile/support', group: 'support', title: 'Support', description: 'Contact options for the support team.' },
  { route: '/dashboard/profile/live-chat', group: 'support', title: 'Live chat', description: 'Chat with a human agent.' },
];

const GROUPS = ['general', 'wallet', 'purchases', 'transactions', 'profile', 'support'];

const byRoute = new Map(ROUTES.map((r) => [r.route, r]));

// Matches a concrete path ("/dashboard/transactions/abc") to its pattern.
function resolve(path) {
  if (byRoute.has(path)) return { entry: byRoute.get(path), pathValues: {} };
  for (const entry of ROUTES) {
    if (!entry.pathParams) continue;
    const re = new RegExp(`^${entry.route.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    const m = path.match(re);
    if (m) {
      const pathValues = {};
      entry.pathParams.forEach((name, i) => { pathValues[name] = decodeURIComponent(m[i + 1]); });
      return { entry, pathValues };
    }
  }
  return null;
}

// Compact text block for the system prompt.
function describe(enabledGroups = GROUPS) {
  return ROUTES.filter((r) => enabledGroups.includes(r.group)).map((r) => {
    const params = r.params ? ` | query: ${Object.entries(r.params).map(([k, v]) => `${k} (${v})`).join(', ')}` : '';
    return `- ${r.route} — ${r.title}: ${r.description}${params}`;
  }).join('\n');
}

module.exports = { ROUTES, GROUPS, resolve, describe };
