import http from "node:http";

// 강서나눔돌봄센터 챗봇의 Gemini 호출 전용 중계 서버.
//
// 배경: Cloudflare Workers는 사용자와 가장 가까운 전 세계 엣지에서 요청마다
// 다르게 실행되는데, Google Gemini API는 일부 지역의 접근을 차단한다
// ("User location is not supported for the API use"). 이 서비스는 항상 같은
// (Google이 허용하는) 리전에서 실행되는 Cloud Run 위에 떠 있으므로, Cloudflare
// Worker가 Google을 직접 호출하는 대신 이 서비스를 거치면 그 문제를 피해간다.
//
// 순수 패스스루 프록시다: 요청을 그대로 Gemini API로 전달하고 응답을 그대로
// 돌려준다. 호출자가 넘긴 x-goog-api-key를 그대로 전달할 뿐, 이 서비스 자체는
// 어떤 키도 저장하지 않는다.
//
// 남용 방지를 위해 전달 가능한 경로를 실제 사용 중인 Gemini 엔드포인트
// (embedContent / generateContent)로만 제한한다.

const UPSTREAM = "https://generativelanguage.googleapis.com";
const ALLOWED_PATH = /^\/v1beta\/models\/[^/]+:(embedContent|generateContent)$/;

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("gemini-relay ok");
    return;
  }


  if (req.method !== "POST" || !ALLOWED_PATH.test(req.url)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  // Cloud Run's front-end proxy strips inbound "x-goog-*" headers (reserved
  // for Google infrastructure use), so the API key must travel under a
  // non-reserved header name and get renamed to x-goog-api-key here before
  // forwarding upstream.
  const apiKey = req.headers["x-relay-api-key"];
  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing x-relay-api-key");
    return;
  }

  try {
    const upstreamRes = await fetch(`${UPSTREAM}${req.url}`, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body,
    });

    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, {
      "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
    });
    res.end(text);
  } catch (err) {
    console.error("relay fetch failed:", err);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad gateway");
  }
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`gemini-relay listening on ${port}`);
});
