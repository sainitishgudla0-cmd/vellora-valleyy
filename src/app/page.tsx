import { getCategoryCounts, getFeatured, getProducts } from "@/lib/catalog";
import { Hero } from "@/components/home/Hero";
import { BrandIntro, BusinessSection, CategoryTicker, DatesNutsCircle, QualityPromise, Ribbons, Testimonials } from "@/components/home/Sections";
import { FeaturedCarousel } from "@/components/home/FeaturedCarousel";
import { CategoryStories } from "@/components/home/CategoryStories";
import { ProcessSteps } from "@/components/home/ProcessSteps";

export const revalidate = 60;

export default async function HomePage() {
  const [featured, all, counts] = await Promise.all([getFeatured(12), getProducts(), getCategoryCounts()]);
  const variantCount = all.reduce((n, p) => n + p.variants.length, 0);

  return (
    <>
      <Hero />
      <CategoryTicker />
      <BrandIntro productCount={all.length} variantCount={variantCount} />
      <FeaturedCarousel products={featured} />
      <CategoryStories counts={counts} />
      <ProcessSteps />
      <Ribbons />
      <Testimonials />
      <QualityPromise />
      <DatesNutsCircle />
      <BusinessSection />
    </>
  );
}
