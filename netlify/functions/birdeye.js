import fetch from 'node-fetch';
import Redis from 'ioredis';

const {
  REDIS_URL,
  WORKER_URL,
  MIN_SWAP_USD = '5000',
  HF_TOKEN
} = process.env;

const redis = new Redis(REDIS_URL);

export async function handler(event) {
  try {
    // Parse incoming body for test mode
    const body = event.body ? JSON.parse(event.body) : {};
    let swap;
    let testMode = false;

    if (body.swap) {
      // Test mode: use provided swap payload
      swap = body.swap;
      testMode = true;
      console.log('🔧 Test mode active, using provided swap:', swap);
    } else {
      // 1. Traer swaps recientes de Birdeye (todos los tokens)
      const resp = await fetch('https://public-api.birdeye.so/public/token/all/recent_swaps', {
        headers: { 'x-chain': 'solana' }
      });
      const { data = [] } = await resp.json();
      if (!data.length) return ok('No hay swaps recientes');

      // 2. Filtrar por volumen mínimo
      const threshold = parseFloat(MIN_SWAP_USD);
      const grandes = data.filter(s => s.amountUsd >= threshold);
      if (!grandes.length) return ok(`No hay swaps ≥ $${threshold}`);

      // 3. Seleccionar el swap más grande
      swap = grandes.sort((a, b) => b.amountUsd - a.amountUsd)[0];
    }

    const tx = swap.txSignature;

    // Skip Redis duplicates in test mode
    if (!testMode && await redis.exists(tx)) {
      return ok(`Swap ${tx} ya procesado`);
    }

    // 4. Detectar ballena: mismo wallet >2 swaps en 10 min
    let isWhale = false;
    if (!testMode) {
      const walletKeyPattern = `wallet:${swap.userAddress}:*`;
      const prevKeys = await redis.keys(walletKeyPattern);
      isWhale = prevKeys.length >= 2;
      const timestamp = Math.floor(Date.now() / 1000);
      await redis.set(`wallet:${swap.userAddress}:${timestamp}`, tx, 'EX', 600);
    }

    // 5. Análisis IA con Hugging Face
    const text = `${swap.tokenSymbol} volumen ${swap.amountUsd.toFixed(2)} USD`;
    const hfResp = await fetch(
      'https://api-inference.huggingface.co/models/distilbert-base-uncased-finetuned-sst-2-english',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs: text })
      }
    );
    const hfJson = await hfResp.json();
    const score = hfJson[0]?.score ?? 0;
    if (!testMode && score < 0.7) {
      return ok(`Score IA bajo (${score.toFixed(2)}) para ${swap.tokenSymbol}`);
    }

    // 6. Construir tags dinámicos
    const tags = ['#Solana'];
    if (isWhale) tags.push('#whale');
    if (swap.firstSwap) tags.push('#newToken');

    const payload = {
      analisis: {
        token: swap.tokenSymbol,
        volumen: swap.amountUsd,
        score,
        tags,
        comentario: testMode
          ? 'Mensaje de prueba - integración completa 🧪'
          : `Swap ${swap.tokenSymbol} por $${swap.amountUsd.toFixed(2)}`
      }
    };

    console.log('📤 Enviando payload al Worker:', payload);
    // 7. Enviar al Worker
    await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // 8. Marcar tx procesada en Redis (solo fuera de test mode)
    if (!testMode) {
      await redis.set(tx, 'ok', 'EX', 600);
    }

    return ok(`Swap ${tx} enviado al Worker`);
  } catch (err) {
    console.error('❌ Error en birdeye:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}

// helper para respuestas 200
function ok(msg) {
  return { statusCode: 200, body: msg };
}
