export async function handler(event, context) {
  console.log("Mensaje recibido:", event.body);
  return {
    statusCode: 200,
    body: "OK",
  };
}
