const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. CORE CONFIG
const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_IP = "https://74.125.22.103"; // Direct IP bypass for DNS issues

let isWorking = false;
let subIds = [];

// 🎯 EXIT STRATEGY: +50% TP / -30% SL
async function monitorPrice(mint, entryPrice, tokens) {
    console.log(`📡 Watchdog Assigned: ${mint.slice(0,6)}`);
    const interval = setInterval(async () => {
        try {
            const res = await axios.get(`${JUP_IP}/v6/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${tokens}&slippageBps=100`, { 
                headers: { 'Host': 'quote-api.jup.ag', 'User-Agent': 'Mozilla/5.0' } 
            });
            const currentPrice = parseFloat(res.data.outAmount) / tokens;
            
            if (currentPrice >= entryPrice * 1.5 || currentPrice <= entryPrice * 0.7) {
                clearInterval(interval);
                const swap = await axios.post(`${JUP_IP}/v6/swap`, { 
                    quoteResponse: res.data, 
                    userPublicKey: wallet.publicKey.toBase58(), 
                    prioritizationFeeLamports: 300000 
                }, { headers: { 'Host': 'quote-api.jup.ag' } });
                
                const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
                tx.sign([wallet]);
                const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                bot.sendMessage(MY_ID, `🎯 AUTO-SELL: ${currentPrice >= entryPrice * 1.5 ? "TAKE PROFIT 🚀" : "STOP LOSS 📉"}\nhttps://solscan.io/tx/${sig}`);
            }
        } catch (e) { /* Silent retry for watchdog */ }
    }, 20000); 
}

// 🚀 THE ELITE BUYER: RugCheck 500 Filter + DNS Bypass
async function buyToken(mint) {
    try {
        console.log(`🛡️ Strict Check: ${mint.slice(0, 8)}`);
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 5000 });
        if (rug.data.score > 500) return console.log(`⚠️ Skip: Score ${rug.data.score}`);

        console.log(`✅ Passed! Fetching IP-Direct Quote...`);
        const quote = await axios.get(`${JUP_IP}/v6/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${Math.floor(0.01 * LAMPORTS_PER_SOL)}&slippageBps=5000`, { 
            headers: { 'Host': 'quote-api.jup.ag', 'User-Agent': 'Mozilla/5.0' } 
        });

        const swap = await axios.post(`${JUP_IP}/v6/swap`, { 
            quoteResponse: quote.data, 
            userPublicKey: wallet.publicKey.toBase58(), 
            prioritizationFeeLamports: 500000 
        }, { headers: { 'Host': 'quote-api.jup.ag' } });

        const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        
        bot.sendMessage(MY_ID, `💎 SNIPE LANDED!\nScore: ${rug.data.score}\nhttps://solscan.io/tx/${sig}`);
        monitorPrice(mint, (0.01 * LAMPORTS_PER_SOL) / parseFloat(quote.data.outAmount), quote.data.outAmount);
    } catch (e) {
        console.log(`🚨 Execution Fail: ${e.message}`);
    }
}

// 🛡️ MEMORY-SHIELD SCANNER
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
                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (tx) {
                        const accs = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
                        const mint = accs.find(a => a !== SOL_MINT && a !== pId.toBase58() && a !== wallet.publicKey.toBase58() && !a.startsWith('1111') && !a.startsWith('Tokenkeg'));
                        if (mint) await buyToken(mint);
                    }
                } catch (e) { }
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

console.log("🚀 MASTER SLEDGEHAMMER ONLINE. GO TO SLEEP.");
toggleScanning(true);
