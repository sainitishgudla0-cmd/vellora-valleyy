import Link from "next/link";
import { HexBadge } from "@/components/ui/Ornaments";

export default function NotFound() {
  return (
    <div className="container-site flex min-h-[70vh] items-center justify-center py-20">
      <div className="w-full max-w-[640px]">
        <HexBadge h={44} tone="sage" innerClassName="px-10 py-12 text-center sm:px-16">
          <p className="script text-[34px] text-leaf">Lost in the valley?</p>
          <h1 className="text-[clamp(3rem,8vw,6rem)] leading-[0.85]">Page not found</h1>
          <p className="mt-3 text-[13.5px] text-forest/75">The page you are looking for doesn&apos;t exist or has moved.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/" className="btn">
              Back home
            </Link>
            <Link href="/shop" className="btn btn-forest">
              Shop products
            </Link>
          </div>
        </HexBadge>
      </div>
    </div>
  );
}
