const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

// 🔗 JITO BUNDLE ENDPOINT (The Private Highway)
const JITO_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
const JITO_TIP_WALLET = new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNNDUM4uUE2HNCFrH17M288u");

const SOL_MINT = "So11111111111111111111111111111111111111112";

// 🚀 THE "NO-DROP" JITO STRIKE
async function jitoStrike(mint) {
    console.log(`[${new Date().toLocaleTimeString()}] 🛰️ INITIATING JITO BUNDLE STRIKE: ${mint.slice(0,6)}`);
    
    try {
        // 1. Get Quote
        const { data: quote } = await axios.get(`https://quote-api.jup.ag/v6/quote`, {
            params: { inputMint: SOL_MINT, outputMint: mint, amount: 0.01 * LAMPORTS_PER_SOL, slippageBps: 5000, onlyDirectRoutes: true },
            timeout: 2000
        });

        // 2. Build Swap
        const { data: swap } = await axios.post(`https://quote-api.jup.ag/v6/swap`, {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            computeUnitPriceMicroLamports: 1000000 // High priority
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
        tx.sign([wallet]);

        // 3. SEND VIA JITO BUNDLE (Guaranteed Processing or Instant Fail)
        const base64Tx = Buffer.from(tx.serialize()).toString('base64');
        const jitoPayload = {
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [[base64Tx]]
        };

        const res = await axios.post(JITO_ENGINE, jitoPayload, { headers: { 'Content-Type': 'application/json' } });
        
        if (res.data.result) {
            const bundleId = res.data.result;
            bot.sendMessage(MY_ID, `🚀 JITO BUNDLE SENT!\nBundle ID: ${bundleId}\n(Trade is now in a private miner queue)`);
            console.log(`✅ Jito Bundle ID: ${bundleId}`);
        } else {
            console.log("🚨 Jito Rejected Bundle:", res.data);
        }

    } catch (e) {
        console.log(`🚨 STRIKE FAILED: ${e.response?.data?.error || e.message}`);
    }
}

// ⛓️ SCANNER LOGIC
async function main() {
    console.log("🚀 V33 JITO-HYPERDRIVE ONLINE.");
    const RAY_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    
    connection.onLogs(RAY_V4, async ({ signature, logs, err }) => {
        if (err || !logs.some(l => l.toLowerCase().includes("init"))) return;
        
        try {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            const mint = tx?.meta?.postTokenBalances?.find(b => b.mint !== SOL_MINT && b.owner !== RAY_V4.toBase58())?.mint;
            if (mint) await jitoStrike(mint);
        } catch (e) { }
    }, 'processed');
}

main();
