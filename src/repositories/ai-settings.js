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
  geminiModel: 'gemini-2.5-flash',
  useGeminiFallback: true,
  temperature: 0.3,
  maxOutputTokens: 900,
  requestTimeoutMs: 25000,
  historyTurns: 10,
  transactionsInContext: 30,
  maxMessageChars: 1000,
  rateLimitPerHour: 40,
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
