import { getProduct } from "@/lib/catalog";
import { fail, json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const product = await getProduct((await params).slug);
  return product ? json({ product }) : fail("Product not found", 404);
}
