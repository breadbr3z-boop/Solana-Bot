const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. REFINED LITE SETUP
const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));

// Fix 409 Conflict: Ensure we don't spam Telegram during restarts
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: { autoStart: true, params: { timeout: 10 } } });

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isWorking = false;
let subIds = [];

// 2. RETRY-ENABLED BUYER
async function buyToken(mint) {
    try {
        console.log(`🛒 Quoting: ${mint.slice(0,4)}...`);
        
        // DNS/Network Retry Loop
        let quoteResponse = null;
        for (let i = 0; i < 3; i++) {
            try {
                const res = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${Math.floor(0.01 * LAMPORTS_PER_SOL)}&slippageBps=5000`, { timeout: 5000 });
                quoteResponse = res.data;
                break;
            } catch (e) {
                console.log(`🔄 Quote Retry ${i+1}...`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!quoteResponse) throw new Error("Jupiter API Unreachable");

        const swapReq = await axios.post('https://quote-api.jup.ag/v6/swap', {
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 150000 // Slightly higher to beat the 2026 congestion
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swapReq.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
        process.env.CHAT_ID && bot.sendMessage(process.env.CHAT_ID, `✅ SUCCESS: https://solscan.io/tx/${sig}`);
        console.log(`🔥 BOUGHT: ${sig}`);
    } catch (e) {
        console.log("🚨 Buy Fail:", e.message);
    }
}

// 3. SCANNER
async function toggleScanning(on) {
    if (!on) {
        for (let id of subIds) await connection.removeOnLogsListener(id).catch(() => {});
        subIds = [];
    } else {
        [RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
            const id = connection.onLogs(pId, async ({ signature, logs, err }) => {
                if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;

                isWorking = true;
                await toggleScanning(false);

                console.log(`🎯 TARGET: ${signature.slice(0, 8)}`);
                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (tx) {
                        const allAccounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
                        const mint = allAccounts.find(addr => addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && !addr.startsWith('1111') && !addr.startsWith('Tokenkeg'));
                        
                        if (mint) {
                            console.log(`✅ PASS: ${mint.slice(0,4)}`);
                            await buyToken(mint);
                        }
                    }
                } catch (e) { console.log("🚨 Trace Error"); }

                setTimeout(() => { isWorking = false; toggleScanning(true); }, 30000); // Shorter 30s cooldown
            }, 'processed');
            subIds.push(id);
        });
    }
}

// Global Cleanup for Telegram 409 errors
process.on('SIGTERM', () => {
    bot.stopPolling();
    process.exit(0);
});

console.log("🚀 LITE APEX V2 ONLINE.");
toggleScanning(true);
