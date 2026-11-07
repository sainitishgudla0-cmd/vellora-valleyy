import { getProducts, parseCatalogQuery } from "@/lib/catalog";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const products = await getProducts(parseCatalogQuery(sp));
  return json({ count: products.length, products });
}
