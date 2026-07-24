#!/usr/bin/env node
/**
 * Cellexia Reviews — demo seed.
 *
 * Usage:
 *   node prisma/seed.js --shop=<my-store.myshopify.com> --product=<numeric product id>
 *   npm run seed:demo -- --shop=my-store.myshopify.com --product=8654321098765
 *
 * Inserts ~15 demo reviews (multi-language, structured attributes, one brand
 * reply) for testing. Refuses to run if the shop already has reviews.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : null;
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(9, 30, 0, 0);
  return date;
}

const shop = readArg("shop");
const productId = readArg("product");

if (!shop || !productId) {
  console.error(
    "Usage: node prisma/seed.js --shop=<my-store.myshopify.com> --product=<numeric product id>",
  );
  process.exit(1);
}
if (!/^\d+$/.test(productId)) {
  console.error(`--product must be a numeric Shopify product id, got "${productId}".`);
  process.exit(1);
}

const PRODUCT_TITLE = "Cellexia Régénérant Cellular Renewal Cream";
const PRODUCT_HANDLE = "cellexia-regenerant-cellular-renewal-cream";

const DEMO_REVIEWS = [
  {
    rating: 5,
    title: "Visible difference in three weeks",
    body: "I have used the Régénérant renewal cream every night for three weeks and the fine lines around my eyes are visibly softer. It sinks in quickly, never stings, and my skin feels plump by morning. A little truly goes a long way.",
    language: "en",
    authorName: "Margaret H.",
    authorEmail: "margaret.h@example.com",
    country: "US",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "55_64",
    skinConcerns: ["fine_lines", "dryness"],
    timeUsing: "m1_3",
    resultsSeen: ["smoother", "fewer_lines"],
    helpfulCount: 12,
    createdAt: daysAgo(60),
    reply:
      "Thank you, Margaret! Consistent nightly use is exactly how the renewal complex works best — we are delighted your skin is loving it. — The Cellexia Team",
    replyAt: daysAgo(58),
  },
  {
    rating: 4,
    title: "Rich texture, a little goes a long way",
    body: "The cream is richer than I expected, so I use half a pump for my whole face. My cheeks stopped flaking within a week and my makeup sits better. One star off because the jar is smaller than it looks.",
    language: "en",
    authorName: "Dana W.",
    authorEmail: "dana.w@example.com",
    country: "GB",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "35_44",
    skinConcerns: ["dryness", "dullness"],
    timeUsing: "m1_3",
    resultsSeen: ["hydration", "radiance"],
    helpfulCount: 7,
    createdAt: daysAgo(48),
  },
  {
    rating: 5,
    title: "Ma peau est transformée",
    body: "Après trois mois d'utilisation matin et soir, ma peau est plus ferme et le grain est affiné. Les ridules du contour des lèvres se sont estompées. C'est la première crème qui tient vraiment ses promesses.",
    language: "fr",
    authorName: "Claire Moreau",
    authorEmail: "claire.moreau@example.com",
    country: "FR",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "45_54",
    skinConcerns: ["fine_lines", "firmness"],
    timeUsing: "m3_6",
    resultsSeen: ["firmer", "fewer_lines"],
    helpfulCount: 9,
    createdAt: daysAgo(42),
  },
  {
    rating: 4,
    title: "Très bonne crème de nuit",
    body: "Texture onctueuse et parfum discret. Ma peau est bien hydratée au réveil. J'attends encore de voir un effet sur les rides, mais après un mois le confort est déjà là.",
    language: "fr",
    authorName: "Sophie Bernard",
    authorEmail: "sophie.bernard@example.com",
    country: "FR",
    variantTitle: "30 ml travel size",
    verified: false,
    status: "PUBLISHED",
    ageRange: "35_44",
    skinConcerns: ["dryness"],
    timeUsing: "w1_4",
    resultsSeen: ["hydration"],
    helpfulCount: 2,
    createdAt: daysAgo(37),
  },
  {
    rating: 5,
    title: "Hält, was sie verspricht",
    body: "Nach sechs Monaten täglicher Anwendung ist meine Haut glatter und deutlich beruhigter. Selbst im Winter keine Spannungsgefühle mehr. Die Creme zieht schnell ein und reizt meine empfindliche Haut überhaupt nicht.",
    language: "de",
    authorName: "Anke Müller",
    authorEmail: "anke.mueller@example.com",
    country: "DE",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "45_54",
    skinConcerns: ["fine_lines", "sensitivity"],
    timeUsing: "m3_6",
    resultsSeen: ["smoother", "calmer"],
    helpfulCount: 6,
    createdAt: daysAgo(33),
  },
  {
    rating: 3,
    title: "Gut, aber sehr reichhaltig",
    body: "Die Pflege ist ordentlich und die Haut fühlt sich gut versorgt an. Für meine Mischhaut ist die Textur allerdings etwas zu schwer, ich benutze sie deshalb nur noch abends.",
    language: "de",
    authorName: "Petra Schmidt",
    authorEmail: "petra.schmidt@example.com",
    country: "DE",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "55_64",
    skinConcerns: ["dryness"],
    timeUsing: "m1_3",
    resultsSeen: ["hydration"],
    helpfulCount: 1,
    createdAt: daysAgo(29),
  },
  {
    rating: 5,
    title: "Mi piel luce radiante",
    body: "Llevo dos meses usándola y mi piel está más luminosa y uniforme. Las manchitas del sol se notan menos y la textura es una delicia: se absorbe sin dejar residuo graso.",
    language: "es",
    authorName: "Lucía Fernández",
    authorEmail: "lucia.fernandez@example.com",
    country: "ES",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "25_34",
    skinConcerns: ["dullness", "texture"],
    timeUsing: "m1_3",
    resultsSeen: ["radiance", "even_tone"],
    helpfulCount: 4,
    createdAt: daysAgo(25),
  },
  {
    rating: 4,
    title: "Buena hidratación sin brillos",
    body: "Hidrata muy bien y no me deja la cara brillante. De momento no veo cambios en los poros, pero acabo de empezar. El envase con dosificador es muy higiénico.",
    language: "es",
    authorName: "Carmen R.",
    authorEmail: "carmen.r@example.com",
    country: "MX",
    variantTitle: "30 ml travel size",
    verified: false,
    status: "PUBLISHED",
    ageRange: "35_44",
    skinConcerns: ["pores", "dryness"],
    timeUsing: "w1_4",
    resultsSeen: ["hydration"],
    helpfulCount: 0,
    createdAt: daysAgo(21),
  },
  {
    rating: 5,
    title: "しっとりするのにべたつかない",
    body: "使い始めて2か月になります。乾燥による小じわが目立たなくなり、朝までしっとりが続きます。香りも控えめで、敏感肌の私でも安心して使えました。リピート決定です。",
    language: "ja",
    authorName: "佐藤 由美",
    authorEmail: "yumi.sato@example.com",
    country: "JP",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "45_54",
    skinConcerns: ["dryness", "fine_lines"],
    timeUsing: "m1_3",
    resultsSeen: ["hydration", "smoother"],
    helpfulCount: 8,
    createdAt: daysAgo(18),
  },
  {
    rating: 5,
    title: "نتيجة رائعة على البقع الداكنة",
    body: "أستخدم الكريم منذ أربعة أشهر وقد أصبحت بشرتي أكثر إشراقاً وتوحّد لونها بشكل ملحوظ. البقع الداكنة خفّت كثيراً، والملمس خفيف يمتصّ بسرعة دون أي لمعان.",
    language: "ar",
    authorName: "ليلى أحمد",
    authorEmail: "layla.ahmed@example.com",
    country: "AE",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "35_44",
    skinConcerns: ["dark_spots", "dullness"],
    timeUsing: "m3_6",
    resultsSeen: ["even_tone", "radiance"],
    helpfulCount: 5,
    createdAt: daysAgo(15),
  },
  {
    rating: 4,
    title: "Ottima per la pelle sensibile",
    body: "Uso la crema da un mese e i rossori si sono attenuati molto. Non pizzica e non profuma troppo. Avrei gradito un formato più grande, ma la qualità c'è tutta.",
    language: "it",
    authorName: "Giulia Ricci",
    authorEmail: "giulia.ricci@example.com",
    country: "IT",
    variantTitle: "30 ml travel size",
    verified: true,
    status: "PUBLISHED",
    ageRange: "25_34",
    skinConcerns: ["sensitivity", "redness"],
    timeUsing: "m1_3",
    resultsSeen: ["calmer"],
    helpfulCount: 3,
    createdAt: daysAgo(12),
  },
  {
    rating: 2,
    title: "Didn't work for my oily skin",
    body: "The formula felt too heavy for my combination skin and I noticed a few clogged pores on my chin after two weeks. It may suit drier skin types, but it isn't for me.",
    language: "en",
    authorName: "Tina L.",
    authorEmail: "tina.l@example.com",
    country: "CA",
    variantTitle: "50 ml jar",
    verified: false,
    status: "PUBLISHED",
    ageRange: "25_34",
    skinConcerns: ["pores"],
    timeUsing: "w1_4",
    resultsSeen: ["too_early"],
    helpfulCount: 2,
    createdAt: daysAgo(9),
  },
  {
    rating: 5,
    title: "My holy grail cream",
    body: "Over a year of daily use and I still get compliments on my skin. Dark circles are brighter, my jawline feels firmer, and it layers perfectly under sunscreen. Worth every penny.",
    language: "en",
    authorName: "Priya S.",
    authorEmail: "priya.s@example.com",
    country: "US",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PUBLISHED",
    ageRange: "35_44",
    skinConcerns: ["dark_circles", "fine_lines"],
    timeUsing: "gt_6m",
    resultsSeen: ["fewer_lines", "firmer"],
    helpfulCount: 15,
    createdAt: daysAgo(6),
  },
  {
    rating: 4,
    title: "Nice but pricey",
    body: "Solid moisturizer that smoothed the rough patches on my forehead within a couple of months. I just wish the refill jars were cheaper — I'll repurchase when it's on promotion.",
    language: "en",
    authorName: "Robert K.",
    authorEmail: "robert.k@example.com",
    country: "US",
    variantTitle: "50 ml jar",
    verified: true,
    status: "PENDING",
    ageRange: "65_plus",
    skinConcerns: ["texture", "dryness"],
    timeUsing: "m3_6",
    resultsSeen: ["smoother"],
    helpfulCount: 3,
    createdAt: daysAgo(3),
  },
  {
    rating: 5,
    title: "Soothed my winter-dry skin overnight",
    body: "First jar and only a few days in, but the tight, red feeling across my cheeks calmed down after the very first night. Too early to judge the anti-aging claims — the comfort alone is worth it.",
    language: "en",
    authorName: "Emma J.",
    authorEmail: "emma.j@example.com",
    country: "SE",
    variantTitle: "30 ml travel size",
    verified: false,
    status: "PENDING",
    ageRange: "under_25",
    skinConcerns: ["dryness", "redness"],
    timeUsing: "lt_1w",
    resultsSeen: ["too_early", "hydration"],
    helpfulCount: 0,
    createdAt: daysAgo(2),
  },
];

async function main() {
  const existing = await prisma.review.count({ where: { shop } });
  if (existing > 0) {
    console.error(
      `Refusing to seed: ${existing} review(s) already exist for ${shop}. ` +
        "The demo seed only runs against an empty shop.",
    );
    process.exitCode = 1;
    return;
  }

  for (const review of DEMO_REVIEWS) {
    const { skinConcerns, resultsSeen, ...rest } = review;
    await prisma.review.create({
      data: {
        ...rest,
        shop,
        productId,
        productTitle: PRODUCT_TITLE,
        productHandle: PRODUCT_HANDLE,
        skinConcerns: JSON.stringify(skinConcerns),
        resultsSeen: JSON.stringify(resultsSeen),
      },
    });
  }

  const published = DEMO_REVIEWS.filter((r) => r.status === "PUBLISHED").length;
  const pending = DEMO_REVIEWS.length - published;
  console.log(
    `Seeded ${DEMO_REVIEWS.length} demo reviews (${published} published, ${pending} pending) ` +
      `for product ${productId} on ${shop}.`,
  );
  console.log(
    "Open the app admin to moderate the pending ones — approving a review " +
      "recomputes product stats and syncs the cellexia.* metafields.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
