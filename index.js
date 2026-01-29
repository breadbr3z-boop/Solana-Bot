const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isWorking = false;
let subIds = [];

// 🛡️ THE FINAL BUYER (IP-DIRECT FALLBACK)
async function buyToken(mint) {
    const urls = [
        "https://quote-api.jup.ag/v6",
        "https://api.jup.ag/swap/v6"
    ];

    for (let url of urls) {
        try {
            console.log(`📡 Attempting Trade: ${url.includes('quote') ? 'Primary' : 'Secondary'}`);
            const quote = await axios.get(`${url}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${Math.floor(0.01 * LAMPORTS_PER_SOL)}&slippageBps=5000`, { timeout: 5000 });
            
            const swap = await axios.post(`${url}/swap`, {
                quoteResponse: quote.data,
                userPublicKey: wallet.publicKey.toBase58(),
                wrapAndUnwrapSol: true,
                prioritizationFeeLamports: 500000 // 🚀 Max Priority
            }, { timeout: 5000 });

            const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
            tx.sign([wallet]);
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            
            if (MY_ID) bot.sendMessage(MY_ID, `✅ LANDED: https://solscan.io/tx/${sig}`);
            console.log("🔥 SUCCESS");
            return;
        } catch (e) {
            console.log(`❌ Path failed: ${e.message}`);
        }
    }
}

// 🛡️ THE MEMORY-GUARDED SCANNER
async function toggleScanning(on) {
    if (!on) {
        for (let id of subIds) await connection.removeOnLogsListener(id).catch(() => {});
        subIds = [];
    } else {
        [RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
            const id = connection.onLogs(pId, async ({ signature, logs, err }) => {
                if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;

                isWorking = true;
                await toggleScanning(false); // Disconnect to save RAM

                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (tx) {
                        const accs = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
                        const mint = accs.find(a => a !== SOL_MINT && a !== pId.toBase58() && a !== wallet.publicKey.toBase58() && !a.startsWith('1111') && !a.startsWith('Tokenkeg'));
                        if (mint) {
                            console.log(`🎯 TARGET: ${mint}`);
                            await buyToken(mint);
                        }
                    }
                } catch (e) { }

                console.log("⏳ Cooling Down...");
                setTimeout(() => { isWorking = false; toggleScanning(true); }, 45000);
            }, 'processed');
            subIds.push(id);
        });
    }
}

process.on('uncaughtException', (err) => { 
    console.log('🛡️ Guard:', err.message); 
    isWorking = false; 
    toggleScanning(true); 
});

console.log("🚀 SLEDGEHAMMER APEX ONLINE. SLEEP NOW.");
toggleScanning(true);
