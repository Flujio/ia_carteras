import { createClient } from 'redis';

export async function handler(event) {
  const client = createClient({ url: process.env.REDIS_URL });

  try {
    await client.connect();

    const body = JSON.parse(event.body);
    const tokenData = body.message.data; // asegúrate que viene con este formato
    const tokenId = tokenData.id;

    // 1. Verifica si ya se procesó
    if (await client.exists(tokenId)) {
      console.log("Token ya procesado");
      return {
        statusCode: 200,
        body: "Token ya procesado",
      };
    }

    // 2. Analizar sentimiento del token
    const sentiment = await analyzeSentiment(tokenData.description);

    // 3. Si el sentimiento es positivo, enviar a Worker de coordinación
    const result = await sendToCoordinator({
      ...tokenData,
      sentiment: sentiment[0]?.label ?? "NEUTRAL",
    });

    // 4. Guardar en Redis por 24h para no repetir
    await client.setEx(tokenId, 86400, "procesado");

    return {
      statusCode: 200,
      body: "Procesado con éxito",
    };
  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: "Error interno",
    };
  } finally {
    await client.quit();
  }
}

// 🧠 Función para análisis de sentimiento con Hugging Face
async function analyzeSentiment(texto) {
  const response = await fetch(
    "https://api-inference.huggingface.co/models/finiteautomata/bertweet-base-sentiment-analysis",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: texto }),
    }
  );
  return await response.json();
}

// 🔁 Función para enviar a Cloudflare Worker
async function sendToCoordinator(data) {
  const response = await fetch("https://coordinacion-worker.TUSUBDOMINIO.workers.dev", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return await response.text();
}
