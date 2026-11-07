import { site } from "@/config/site";
import { Marquee } from "@/components/ui/Ornaments";

const items = ["From source to shelf", "Bulk supply across India", `FSSAI Lic. No. ${site.fssaiLicense}`, "Anantapur, Andhra Pradesh"];

function Row() {
  return (
    <>
      {items.map((t) => (
        <span key={t} className="flex items-center gap-5 px-5">
          <span>{t}</span>
          <span aria-hidden className="h-1 w-1 rotate-45 bg-gold" />
        </span>
      ))}
    </>
  );
}

export function AnnouncementBar() {
  return (
    <div className="relative z-[60] bg-forest-deep text-cream/90">
      <div className="eyebrow hidden h-9 items-center justify-center gap-5 lg:flex">
        {items.map((t, i) => (
          <span key={t} className="flex items-center gap-5">
            {i > 0 && <span aria-hidden className="h-1 w-1 rotate-45 bg-gold" />}
            {t}
          </span>
        ))}
      </div>
      <Marquee className="eyebrow h-9 items-center lg:hidden" speed={30}>
        <Row />
      </Marquee>
    </div>
  );
}
