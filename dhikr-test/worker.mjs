const json = (data, status = 200) => Response.json(data, {status, headers: {"Cache-Control":"no-store"}});

export class Counter {
  constructor(state) { this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS stats (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    this.sql.exec("INSERT OR IGNORE INTO stats VALUES(1,0)");
    // Freeze the one-time adjustment while retaining each installation’s receipt.
    this.sql.exec("INSERT OR IGNORE INTO stats(id,n) SELECT 2, 32000-n FROM stats WHERE id=1");
  }
  async fetch(request) {
    if (request.method === "POST") {
      const {id, count} = await request.json();
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
          !Number.isSafeInteger(count) || count < 0 || count > 2147483647) return json({error:"invalid"},400);
      const previous = this.sql.exec("SELECT n FROM receipts WHERE id=?",id).toArray()[0]?.n || 0;
      if (count > previous) {
        this.sql.exec("INSERT INTO receipts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET n=excluded.n",id,count);
        this.sql.exec("UPDATE stats SET n=n+? WHERE id=1",count-previous);
      }
    }
    return json({total:this.sql.exec("SELECT SUM(n) AS total FROM stats").one().total});
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!["/v1/total","/test/verify"].includes(path) || !["GET","POST"].includes(request.method)) return json({error:"not found"},404);
    if (request.method === "POST" && (!request.headers.get("content-type")?.startsWith("application/json") || Number(request.headers.get("content-length") || 0) > 512)) return json({error:"invalid"},400);
    const id = env.COUNTERS.idFromName(path);
    try { return await env.COUNTERS.get(id).fetch(request); }
    catch { return json({error:"unavailable"},503); }
  }
};