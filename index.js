const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. SYSTEM SETUP
const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isWorking = false;
let subIds = [];

// 2. THE AGGRESSIVE BUYER (Multi-Endpoint Fallback)
async function buyToken(mint) {
    // Try these in order: API 1, then API 2
    const endpoints = [
        "https://quote-api.jup.ag/v6",
        "https://api.jup.ag/swap/v6"
    ];

    for (const api of endpoints) {
        try {
            console.log(`📡 Trying ${api.includes('quote') ? 'Standard' : 'Global'} API for ${mint.slice(0,4)}...`);
            
            const quoteRes = await axios.get(`${api}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${Math.floor(0.01 * LAMPORTS_PER_SOL)}&slippageBps=5000`, { timeout: 5000 });
            
            const swapRes = await axios.post(`${api}/swap`, {
                quoteResponse: quoteRes.data,
                userPublicKey: wallet.publicKey.toBase58(),
                wrapAndUnwrapSol: true,
                prioritizationFeeLamports: 400000 // 🚀 2026 Gas - Must be high to land
            }, { timeout: 8000 });

            const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
            tx.sign([wallet]);
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            
            const success = `✅ BOUGHT! https://solscan.io/tx/${sig}`;
            console.log(success);
            if (process.env.CHAT_ID) bot.sendMessage(process.env.CHAT_ID, success);
            return; // Exit if successful

        } catch (e) {
            const msg = e.response?.data?.error || e.message;
            console.log(`❌ ${api.slice(8, 15)} Failed: ${msg}`);
            // If it's a 429 or 401, the loop will try the next endpoint
        }
    }
}

// 3. THE SCANNER
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
                        const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
                        const mint = accounts.find(addr => 
                            addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && 
                            !addr.startsWith('1111') && !addr.startsWith('Tokenkeg')
                        );
                        
                        if (mint) {
                            console.log(`✅ VERIFIED: ${mint.slice(0, 4)}`);
                            await buyToken(mint);
                        }
                    }
                } catch (e) { console.log("🚨 Scan Error"); }

                console.log("⏳ 45s Cooldown...");
                setTimeout(() => { isWorking = false; toggleScanning(true); }, 45000);
            }, 'processed');
            subIds.push(id);
        });
    }
}

console.log("🚀 UNIVERSAL APEX V3 ONLINE.");
toggleScanning(true);
