const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. RECOVERY SETUP
const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

// 🌐 THE "PUBLIC" ENDPOINTS (No API Key Required)
const JUP_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP = "https://quote-api.jup.ag/v6/swap";

let isWorking = false;
let subIds = [];

// 2. THE PUBLIC BUYER
async function buyToken(mint) {
    try {
        console.log(`📡 Fetching Public Quote for ${mint.slice(0, 6)}...`);
        
        // Use standard Public API with a specific User-Agent to avoid the 401
        const quoteRes = await axios.get(`${JUP_QUOTE}?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${Math.floor(0.01 * LAMPORTS_PER_SOL)}&slippageBps=5000`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 6000
        });

        if (!quoteRes.data) throw new Error("Quote Denied");

        const swapRes = await axios.post(JUP_SWAP, {
            quoteResponse: quoteRes.data,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 250000 
        }, { timeout: 8000 });

        const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        
        const successMsg = `✅ SUCCESS: https://solscan.io/tx/${sig}`;
        console.log(successMsg);
        if (process.env.CHAT_ID) bot.sendMessage(process.env.CHAT_ID, successMsg);

    } catch (e) {
        console.log(`🚨 Buy Failed: ${e.response?.status === 401 ? "Auth Required (Switching...)" : e.message}`);
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
                        const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
                        const mint = accounts.find(addr => 
                            addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && 
                            !addr.startsWith('1111') && !addr.startsWith('Tokenkeg')
                        );
                        
                        if (mint) {
                            console.log(`✅ PASS: ${mint.slice(0, 4)}`);
                            await buyToken(mint);
                        }
                    }
                } catch (e) { }

                console.log("⏳ Cooldown 45s...");
                setTimeout(() => { isWorking = false; toggleScanning(true); }, 45000);
            }, 'processed');
            subIds.push(id);
        });
    }
}

process.on('uncaughtException', (err) => {
    console.log('🛡️ Blocked Crash:', err.message);
    isWorking = false;
    toggleScanning(true);
});

console.log("🚀 PUBLIC APEX ONLINE.");
toggleScanning(true);
