const { collection } = require('../services/mongo');
const { GROUPS } = require('../ai/app-map');

const SETTINGS = 'SETTINGS';
const DOC_ID = 'ai';

const DEFAULTS = Object.freeze({
  enabled: true,
  assistantName: 'Swiftza AI',
  greeting: 'Hi {firstName} 👋 I can check your balance, explain any transaction, work out funding fees, or set up a purchase for you. What do you need?',
  primaryProvider: 'openrouter',
  openrouterModel: 'google/gemini-2.5-flash',
  openrouterFallbackModels: ['openai/gpt-4o-mini'],
  geminiModel: 'gemini-flash-latest',
  useGeminiFallback: true,
  temperature: 0.3,
  maxOutputTokens: 900,
  requestTimeoutMs: 25000,
  historyTurns: 10,
  transactionsInContext: 30,
  maxMessageChars: 1000,
  rateLimitPerHour: 40,
  // At or below this wallet balance (naira) the assistant only offers a top-up.
  lowBalanceThreshold: 100,
  // Signed-out visitors (the public /ai page). They can ask about prices,
  // fees and the app; anything on an account goes through the sign-in card.
  guestEnabled: true,
  guestGreeting: "Hi 👋 I'm Swiftza AI. Ask me about prices and fees, or sign in and I'll pay your bills right here in the chat.",
  guestSuggestions: ['How much is MTN 1GB?', 'What is the fee to add ₦5,000?', 'Create an account', 'Log in'],
  // Per browser, and per network address (shared by everyone behind one
  // mobile carrier gateway, hence higher).
  guestRateLimitPerHour: 15,
  guestIpRateLimitPerHour: 60,
  // Guest quick buy: pay one bill by card with no account. Capped, because
  // card payments without an account are what card fraud looks for.
  guestQuickBuyEnabled: true,
  guestMaxOrder: 20000,
  guestDailyLimitPerEmail: 50000,
  allowActions: true,
  actionGroups: [...GROUPS],
  refusalMessage: 'I can only help with your Swiftza account: payments, bills, top-ups, transactions and how the app works.',
  supportContact: 'Use Profile → Support or Live chat in the app.',
  maintenanceMessage: 'Swiftza AI is taking a short break. You can still use every service from the home screen.',
  extraInstructions: '',
  suggestions: ['What did I spend this month?', 'Why was my last purchase reversed?', 'How much is the fee to add ₦5,000?', 'Buy ₦500 MTN airtime'],
  faqs: [
    { q: 'How long does a wallet top-up take?', a: 'Card top-ups are credited as soon as Paystack confirms the payment, usually within seconds. If a payment shows as successful at your bank but not in Swiftza after 10 minutes, use "Already paid? Verify here" on the payment screen with your reference.' },
    { q: 'What happens if a purchase fails?', a: 'If the provider rejects the purchase, the money is returned to your wallet automatically and the transaction shows as reversed.' },
    { q: 'What does "pending" or "under review" mean?', a: 'The provider did not confirm the result in time. The amount stays on hold while our team checks with the provider, then it is either completed or refunded to your wallet.' },
    { q: 'Can I get a refund to my bank account?', a: 'Refunds for failed purchases go back to your Swiftza wallet. For a bank withdrawal, contact support.' },
    { q: 'I forgot my transaction PIN', a: 'Go to Profile → Security → Change PIN.' },
  ],
});

const ALLOWED_KEYS = Object.keys(DEFAULTS);

async function load() {
  const doc = await collection(SETTINGS).findOne({ _id: DOC_ID });
  const stored = doc?.config || {};
  return { ...DEFAULTS, ...stored, updatedAt: doc?.updatedAt || null, updatedBy: doc?.updatedBy || null };
}

async function save(config, adminUid) {
  await collection(SETTINGS).updateOne(
    { _id: DOC_ID },
    { $set: { config, updatedAt: new Date(), updatedBy: adminUid || null } },
    { upsert: true }
  );
  return load();
}

module.exports = { load, save, DEFAULTS, ALLOWED_KEYS };
