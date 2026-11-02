// Netlify (event)=>{statusCode,body} 风格处理器 → Cloudflare Pages Functions 适配
function adaptPages(netlifyHandler) {
  return async function onRequest(context) {
    const request = context.request;
    let body = "";
    if (request.method === "POST") {
      body = await request.text();
    }
    const event = {
      httpMethod: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      isBase64Encoded: false,
    };
    try {
      const result = await netlifyHandler(event);
      return new Response(result.body || "", {
        status: result.statusCode || 200,
        headers: result.headers || { "content-type": "application/json; charset=utf-8" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Server error.", detail: String(error.message || error) }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  };
}

module.exports = { adaptPages };
