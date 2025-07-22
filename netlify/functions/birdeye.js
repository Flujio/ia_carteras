const { createClient } = require('redis');
const fetch = require('node-fetch');

exports.handler = async function (event, context) {
  try {
    // 🔌 Conexión a Redis
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL no está definido en variables de entorno');

    const redis = createClient({ url: redisUrl });
    await redis.connect();

    const keys = await redis.keys('*');
    const datos = [];

    for (const key of keys) {
      const value = await redis.get(key);
      datos.push({ key, value });
    }

    await redis.disconnect();

    if (datos.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No hay datos en Redis.' }),
      };
    }

    // 🧠 Análisis con Hugging Face (sentiment analysis de ejemplo)
    const huggingFaceToken = process.env.HUGGINGFACE_API_KEY;
    if (!huggingFaceToken) throw new Error('HUGGINGFACE_API_KEY no está definido');

    const hfResponse = await fetch(
      'https://api-inference.huggingface.co/models/distilbert-base-uncased-finetuned-sst-2-english',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${huggingFaceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: datos.map(d => d.value).join('\n'),
        }),
      }
    );

    const hfResult = await hfResponse.json();

    // 🚀 Envío de resultados al Worker de Cloudflare
    const cloudflareUrl = process.env.CLOUDFLARE_WORKER_URL;
    if (!cloudflareUrl) throw new Error('CLOUDFLARE_WORKER_URL no está definido');

    const sendResponse = await fetch(cloudflareUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        datos: datos,
        analisis: hfResult,
      }),
    });

    const sendResult = await sendResponse.text();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: '✅ Datos analizados y enviados con éxito',
        keys: keys.length,
        cloudflare_response: sendResult,
      }),
    };
  } catch (error) {
    console.error('❌ Error en birdeye.js:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || 'Error interno en función birdeye',
      }),
    };
  }
};
