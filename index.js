const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. SETUP & PROXY CONFIG
const HELIUS_RPC = process.env.RPC_URL.trim();
const connection = new Connection(HELIUS_RPC, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });

// Convert RPC URL to Helius API Proxy URL
const JUP_PROXY = `${HELIUS_RPC.replace('rpc', 'api').split('?')[0]}/jup/quote${HELIUS_RPC.includes('api-key') ? '?api-key=' + HELIUS_RPC.split('api-key=')[1] : ''}`;
const SWAP_PROXY = `${HELIUS_RPC.replace('rpc', 'api').split('?')[0]}/jup/swap${HELIUS_RPC.includes('api-key') ? '?api-key=' + HELIUS_RPC.split('api-key=')[1] : ''}`;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isWorking = false;
let subIds = [];

// 2. THE PROXY BUYER
async function buyToken(mint) {
    try {
        console.log(`📡 Helius Proxy Quote: ${mint.slice(0, 6)}...`);
        
        // Use Helius as the middleman to talk to Jupiter
        const quoteRes = await axios.get(JUP_PROXY + (JUP_PROXY.includes('?') ? '&' : '?') + `inputMint=${SOL_MINT}&outputMint=${mint}&amount=${Math.floor(0.01 * LAMPORTS_PER_SOL)}&slippageBps=5000`, { timeout: 10000 });
        
        if (!quoteRes.data) throw new Error("Proxy returned empty quote");

        const swapRes = await axios.post(SWAP_PROXY, {
            quoteResponse: quoteRes.data,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 350000 
        }, { timeout: 12000 });

        const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
        
        const msg = `🚀 PROXY BUY SUCCESS!\nhttps://solscan.io/tx/${sig}`;
        console.log(msg);
        if (process.env.CHAT_ID) bot.sendMessage(process.env.CHAT_ID, msg);

    } catch (e) {
        console.log(`🚨 Proxy Fail: ${e.response?.data?.error || e.message}`);
    }
}

// 3. SCANNER LOGIC
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
                } catch (e) { }

                console.log("⏳ Cooldown 45s...");
                setTimeout(() => { isWorking = false; toggleScanning(true); }, 45000);
            }, 'processed');
            subIds.push(id);
        });
    }
}

// Global Cleanup
process.on('SIGTERM', () => {
    bot.stopPolling();
    process.exit(0);
});

console.log("🚀 PROXY APEX ONLINE.");
toggleScanning(true);
