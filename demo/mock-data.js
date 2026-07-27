/*!
 * Cellexia Reviews — demo dataset (demo/mock-data.js)
 *
 * Defines window.CellexiaDemoData with the exact JSON shapes of the storefront
 * API (SPEC §6) so the real widget (assets/cellexia-reviews.js) can hydrate
 * fully offline when the root element carries data-demo="true".
 *
 * - product / summary / reviews / media_gallery / page / per_page / total /
 *   total_pages mirror GET /apps/cellexia/api/reviews.
 * - translations["<reviewId>"]["<target>"] mirrors the per-id payload of
 *   POST /apps/cellexia/api/translate so "Translate" works offline.
 * - badges["<handle>"] mirrors the inner "badges" map of
 *   GET /apps/cellexia/api/badges (SPEC-1.5 §2) so the v1.5 site-wide star
 *   badges render offline on the demo page's product card grid.
 * - brand mirrors the response of GET /apps/cellexia/api/brand-reviews
 *   (SPEC-1.9 §1): { stats: ShopStatsDTO, reviews: BrandReviewDTO[] } — the
 *   v1.9 "Overall reviews" block's distribution-bar filter (initOverall's
 *   demo branch reads CellexiaDemoData.brand.reviews) re-renders its cards
 *   from this pool in demo mode instead of fetching. The pool holds ALL
 *   candidate reviews (all star levels); the widget script applies the
 *   ?stars=N filter locally, like demoList does for the product widget.
 *   Each entry also carries the metafield-shape extras initOverall's
 *   buildCard reads (productReviewCount for the "Read N reviews" link).
 * - All media are inline SVG data URIs (gradient placeholders, one "video").
 *   Zero network requests are made by this file.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Inline SVG media placeholders
   * ------------------------------------------------------------------ */

  function svgUri(w, h, c1, c2, play) {
    var min = Math.min(w, h);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + c1 + '"/>' +
      '<stop offset="1" stop-color="' + c2 + '"/>' +
      '</linearGradient></defs>' +
      '<rect width="' + w + '" height="' + h + '" fill="url(#g)"/>' +
      '<circle cx="' + w * 0.5 + '" cy="' + h * 0.38 + '" r="' + min * 0.2 + '" fill="rgba(255,255,255,0.5)"/>' +
      '<rect x="' + w * 0.36 + '" y="' + h * 0.56 + '" width="' + w * 0.28 + '" height="' + h * 0.2 + '" rx="' + min * 0.035 + '" fill="rgba(255,255,255,0.32)"/>' +
      '<ellipse cx="' + w * 0.42 + '" cy="' + h * 0.32 + '" rx="' + min * 0.055 + '" ry="' + min * 0.03 + '" fill="rgba(255,255,255,0.65)"/>';
    if (play) {
      svg +=
        '<circle cx="' + w * 0.5 + '" cy="' + h * 0.5 + '" r="' + min * 0.16 + '" fill="rgba(15,17,17,0.55)"/>' +
        '<path d="M ' + (w * 0.5 - min * 0.05) + ' ' + (h * 0.5 - min * 0.08) +
        ' L ' + (w * 0.5 + min * 0.09) + ' ' + h * 0.5 +
        ' L ' + (w * 0.5 - min * 0.05) + ' ' + (h * 0.5 + min * 0.08) +
        ' Z" fill="#FFFFFF"/>';
    }
    svg += '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function media(id, type, c1, c2) {
    var play = type === 'VIDEO';
    return {
      id: id,
      type: type,
      url: svgUri(720, 720, c1, c2, play),
      thumbUrl: svgUri(200, 200, c1, c2, play)
    };
  }

  /* ------------------------------------------------------------------ *
   * Reviews (28 — en/fr/de/es/ja/ar mix, §6 ReviewDTO shape)
   * ------------------------------------------------------------------ */

  var reviews = [
    {
      id: 'demo-0001',
      rating: 5,
      title: 'Instantly Soothes My Skin',
      body: 'I have very dry, reactive skin and most creams either sting or sit on top of my face without sinking in. This one is different. It instantly soothes any tightness and my skin stays hydrated well into the next morning. A little goes a long way and it layers beautifully under sunscreen. After about six weeks the fine lines around my eyes look softer.',
      language: 'en',
      authorName: 'Gen Bea',
      country: 'US',
      variantTitle: '3.38 Fl Oz (Pack of 1)',
      verified: true,
      createdAt: '2026-07-16T09:24:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['fine_lines', 'dryness'],
      timeUsing: 'm1_3',
      resultsSeen: ['smoother', 'hydration'],
      helpfulCount: 3,
      reply: null,
      replyAt: null,
      media: [media('demo-m-0001a', 'IMAGE', '#F7D9CF', '#E8A798')]
    },
    {
      id: 'demo-0002',
      rating: 5,
      title: 'The only moisturizer that made a visible difference',
      body: 'I turned 58 this spring and I have tried more face creams than I care to admit — department store brands, prescription retinoids, the lot. Cellexia Régénérant is the first moisturizer in years that actually changed the texture of my skin instead of just sitting on it. The cream itself is rich but somehow still lightweight; it absorbs in under a minute and leaves zero greasy residue, so I can apply makeup right after. Within two weeks my cheeks felt noticeably smoother, and by the two-month mark the crepey texture on my jawline had visibly improved. My dermatologist even commented on it at my last appointment. It is fragrance-free, which my sensitive skin appreciates, and one jar has lasted me almost three months using it morning and night. Worth every penny in my opinion. I have already ordered a second jar and convinced my sister to try it too.',
      language: 'en',
      authorName: 'Margaret Ellison',
      country: 'US',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-05-04T14:02:00.000Z',
      ageRange: '55_64',
      skinConcerns: ['fine_lines', 'texture', 'dryness'],
      timeUsing: 'm3_6',
      resultsSeen: ['smoother', 'fewer_lines', 'firmer'],
      helpfulCount: 214,
      reply: 'Thank you so much, Margaret — reviews like yours are why we do this. We are delighted the Régénérant cream is working for you, and your sister is in good hands. — The Cellexia Care Team',
      replyAt: '2026-05-06T10:15:00.000Z',
      media: [
        media('demo-m-0002a', 'IMAGE', '#EFE3D0', '#D9BE93'),
        media('demo-m-0002b', 'IMAGE', '#F8EFD9', '#E3C776')
      ]
    },
    {
      id: 'demo-0003',
      rating: 4,
      title: 'Lovely texture, a little pricey',
      body: 'The texture of this cream is genuinely lovely — silky, cushiony, spreads easily and leaves my skin smooth and comfortable all day. I have been using it for about five weeks and my forehead lines look slightly softer. The only reason I am holding back a star is the price; it is an investment. That said, you need very little per application, so the jar is lasting longer than I expected and the value is better than it first appears.',
      language: 'en',
      authorName: 'Priya Raman',
      country: 'GB',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-06-21T18:40:00.000Z',
      ageRange: '35_44',
      skinConcerns: ['fine_lines', 'dullness'],
      timeUsing: 'm1_3',
      resultsSeen: ['smoother', 'radiance'],
      helpfulCount: 58,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0004',
      rating: 5,
      title: 'Finally — something my sensitive skin tolerates',
      body: 'My skin flares up at almost everything, so I patch-tested this for a week before using it on my face. Not a single reaction. It is fragrance-free and feels incredibly gentle going on, with no sting even around my nose where I am usually red. Three months in, my redness is calmer and my skin barrier feels stronger. This has earned a permanent spot on my shelf.',
      language: 'en',
      authorName: 'Janet W.',
      country: 'US',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-04-18T08:12:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['sensitivity', 'redness'],
      timeUsing: 'm3_6',
      resultsSeen: ['calmer', 'hydration'],
      helpfulCount: 41,
      reply: null,
      replyAt: null,
      media: [media('demo-m-0004a', 'IMAGE', '#DCE8DC', '#A8C3A0')]
    },
    {
      id: 'demo-0005',
      rating: 2,
      title: 'Broke me out, sadly',
      body: 'I really wanted to love this cream and for the first week it felt wonderful. Unfortunately it clogged my pores — by day ten I had small breakouts across my chin and forehead that I never normally get. My skin leans combination, so if yours is oily or congestion-prone I would sample first. To be fair, the texture and scent-free formula are top notch, and it may suit drier skin types much better.',
      language: 'en',
      authorName: 'Adrienne Foster',
      country: 'US',
      variantTitle: '1.7 Fl Oz (Pack of 1)',
      verified: true,
      createdAt: '2026-03-02T21:55:00.000Z',
      ageRange: '25_34',
      skinConcerns: ['pores', 'texture'],
      timeUsing: 'w1_4',
      resultsSeen: ['too_early'],
      helpfulCount: 96,
      reply: 'We are sorry the cream did not agree with your skin, Adrienne. Régénérant is rich by design, and on combination or oily skin we recommend a thinner layer at night only. Please contact care@cellexia.com — we will happily arrange a refund. — The Cellexia Care Team',
      replyAt: '2026-03-03T09:31:00.000Z',
      media: []
    },
    {
      id: 'demo-0006',
      rating: 5,
      title: 'See it glide on — weightless!',
      body: 'Filmed a quick clip so you can see the consistency. It looks rich in the jar but glides on completely weightless and non-greasy — you can see the finish in my video. Absorbs before I finish my coffee. Two months in and my skin is glowing.',
      language: 'en',
      authorName: 'Denise Kowalski',
      country: 'CA',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-07-02T16:07:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['dullness', 'dryness'],
      timeUsing: 'm1_3',
      resultsSeen: ['radiance', 'hydration'],
      helpfulCount: 12,
      reply: null,
      replyAt: null,
      media: [media('demo-m-0006a', 'VIDEO', '#2E3A40', '#5C7482')]
    },
    {
      id: 'demo-0007',
      rating: 5,
      title: 'Une hydratation exceptionnelle',
      body: "Je l'utilise matin et soir depuis deux mois et mon teint est transformé. La crème est riche mais pénètre rapidement, et l'hydratation dure toute la journée. Mes ridules autour des yeux sont visiblement atténuées. C'est devenu l'étape indispensable de ma routine.",
      language: 'fr',
      authorName: 'Camille Rousseau',
      country: 'FR',
      variantTitle: 'Pot 50 mL',
      verified: true,
      createdAt: '2026-06-30T07:48:00.000Z',
      ageRange: '35_44',
      skinConcerns: ['fine_lines', 'dryness'],
      timeUsing: 'm1_3',
      resultsSeen: ['hydration', 'fewer_lines'],
      helpfulCount: 27,
      reply: null,
      replyAt: null,
      media: [media('demo-m-0007a', 'IMAGE', '#F5E6EE', '#D9A7C7')]
    },
    {
      id: 'demo-0008',
      rating: 4,
      title: 'Très bonne crème, texture parfaite',
      body: "La texture est parfaite : ni grasse ni collante, elle laisse la peau douce et lisse. Après six semaines, ma peau est plus ferme et plus lumineuse. J'enlève une étoile car j'aurais aimé un pot plus grand, mais je rachèterai sans hésiter.",
      language: 'fr',
      authorName: 'Élodie Marchand',
      country: 'FR',
      variantTitle: 'Pot 50 mL',
      verified: false,
      createdAt: '2026-05-27T12:19:00.000Z',
      ageRange: '25_34',
      skinConcerns: ['texture', 'dullness'],
      timeUsing: 'm1_3',
      resultsSeen: ['smoother', 'firmer'],
      helpfulCount: 9,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0009',
      rating: 5,
      title: 'Ma peau sensible l’adore',
      body: "Enfin une crème anti-âge sans parfum qui n'irrite pas ma peau réactive. Elle apaise les rougeurs et hydrate en profondeur sans effet gras. Après trois mois d'utilisation, ma peau est plus calme et plus souple qu'elle ne l'a été depuis des années.",
      language: 'fr',
      authorName: 'Nadia Benali',
      country: 'BE',
      variantTitle: 'Pot 50 mL',
      verified: true,
      createdAt: '2026-04-09T19:03:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['sensitivity', 'redness'],
      timeUsing: 'm3_6',
      resultsSeen: ['calmer', 'hydration'],
      helpfulCount: 15,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0010',
      rating: 5,
      title: 'Endlich sichtbare Ergebnisse',
      body: 'Ich verwende die Creme seit vier Monaten und bin begeistert. Sie zieht schnell ein, verstopft die Poren nicht und hinterlässt keinen Fettfilm. Meine Haut wirkt straffer und die feinen Linien an der Stirn sind deutlich weicher geworden. Auch unter Make-up hält sie hervorragend.',
      language: 'de',
      authorName: 'Ingrid Hoffmann',
      country: 'DE',
      variantTitle: 'Tiegel 50 ml',
      verified: true,
      createdAt: '2026-05-12T10:26:00.000Z',
      ageRange: '55_64',
      skinConcerns: ['fine_lines', 'firmness'],
      timeUsing: 'm3_6',
      resultsSeen: ['firmer', 'fewer_lines'],
      helpfulCount: 34,
      reply: 'Vielen Dank für Ihr wunderbares Feedback, Frau Hoffmann! Es freut uns sehr, dass Sie sichtbare Ergebnisse sehen. — Ihr Cellexia Team',
      replyAt: '2026-05-13T08:44:00.000Z',
      media: [media('demo-m-0010a', 'IMAGE', '#E3E9F2', '#A9BDD6')]
    },
    {
      id: 'demo-0011',
      rating: 4,
      title: 'Sehr angenehm, leichter Duft fehlt mir',
      body: 'Die Creme ist herrlich leicht und pflegt trockene Haut zuverlässig. Nach sechs Wochen fühlt sich meine Haut glatter an. Dass sie komplett parfümfrei ist, ist sicher gut für empfindliche Haut — ich persönlich vermisse einen dezenten Duft, daher ein Stern Abzug.',
      language: 'de',
      authorName: 'Sabine Krüger',
      country: 'AT',
      variantTitle: 'Tiegel 50 ml',
      verified: true,
      createdAt: '2026-06-05T15:58:00.000Z',
      ageRange: '35_44',
      skinConcerns: ['dryness'],
      timeUsing: 'm1_3',
      resultsSeen: ['smoother', 'hydration'],
      helpfulCount: 6,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0012',
      rating: 3,
      title: 'Gut, aber teuer',
      body: 'Die Qualität ist unbestritten gut, die Creme zieht schnell ein und pflegt ordentlich. Für den Preis hätte ich allerdings noch deutlichere Ergebnisse erwartet. Nach zwei Monaten sehe ich nur geringe Veränderungen. Das Preis-Leistungs-Verhältnis überzeugt mich noch nicht ganz.',
      language: 'de',
      authorName: 'Petra Lindemann',
      country: 'DE',
      variantTitle: 'Tiegel 50 ml',
      verified: true,
      createdAt: '2026-02-14T11:34:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['fine_lines'],
      timeUsing: 'm1_3',
      resultsSeen: ['too_early'],
      helpfulCount: 22,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0013',
      rating: 5,
      title: 'Mi piel nunca había estado tan hidratada',
      body: 'Llevo diez semanas usándola y mi piel está más luminosa, suave e hidratada que nunca. La textura es una maravilla: rica pero nada grasa, se absorbe enseguida. Las manchitas del sol se ven más atenuadas y el tono mucho más uniforme.',
      language: 'es',
      authorName: 'María Fernanda López',
      country: 'ES',
      variantTitle: 'Tarro 50 ml',
      verified: true,
      createdAt: '2026-06-11T20:21:00.000Z',
      ageRange: '35_44',
      skinConcerns: ['dark_spots', 'dullness'],
      timeUsing: 'm1_3',
      resultsSeen: ['radiance', 'even_tone', 'hydration'],
      helpfulCount: 18,
      reply: null,
      replyAt: null,
      media: [media('demo-m-0013a', 'IMAGE', '#FDE8DD', '#F0B49A')]
    },
    {
      id: 'demo-0014',
      rating: 5,
      title: 'Perfecta para piel sensible, sin perfume',
      body: 'Tengo la piel muy sensible y casi todo me irrita. Esta crema, al ser sin perfume, no me ha dado ninguna reacción. Calma las rojeces y deja la piel suave y confortable todo el día. Después de dos meses, mi piel está visiblemente más tranquila.',
      language: 'es',
      authorName: 'Carmen Ortega',
      country: 'MX',
      variantTitle: 'Tarro 50 ml',
      verified: false,
      createdAt: '2026-05-19T13:47:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['sensitivity', 'redness'],
      timeUsing: 'm1_3',
      resultsSeen: ['calmer'],
      helpfulCount: 7,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0015',
      rating: 5,
      title: '肌がふっくら、化粧のりが変わりました',
      body: '使い始めて3か月になります。こっくりしたテクスチャーなのにべたつかず、朝までしっかり保湿が続きます。目元の小じわが目立たなくなり、化粧のりが格段に良くなりました。敏感肌ですが刺激は一切ありません。',
      language: 'ja',
      authorName: '佐藤 由美',
      country: 'JP',
      variantTitle: '50mL ジャー',
      verified: true,
      createdAt: '2026-04-27T02:36:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['fine_lines', 'dryness'],
      timeUsing: 'm3_6',
      resultsSeen: ['hydration', 'fewer_lines'],
      helpfulCount: 29,
      reply: null,
      replyAt: null,
      media: [media('demo-m-0015a', 'IMAGE', '#EADFF2', '#C0A6D8')]
    },
    {
      id: 'demo-0016',
      rating: 4,
      title: '軽いつけ心地で気に入っています',
      body: 'テクスチャーがとても軽く、塗った直後からさらっとします。乾燥による小じわには少しずつ効果を感じていますが、劇的な変化はまだです。香料が入っていないところも安心です。もう少し続けてみます。',
      language: 'ja',
      authorName: '田中 恵子',
      country: 'JP',
      variantTitle: '50mL ジャー',
      verified: true,
      createdAt: '2026-07-08T05:11:00.000Z',
      ageRange: '35_44',
      skinConcerns: ['dryness', 'fine_lines'],
      timeUsing: 'm1_3',
      resultsSeen: ['too_early', 'hydration'],
      helpfulCount: 4,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0017',
      rating: 5,
      title: 'أفضل كريم جربته لبشرتي',
      body: 'أستخدمه منذ ثلاثة أشهر وبشرتي أصبحت أكثر نضارة ونعومة. الكريم خالٍ من العطور ولا يسبب أي تهيج لبشرتي الحساسة، ويرطب بعمق دون ملمس دهني. الخطوط الرفيعة حول عيني أصبحت أقل وضوحاً.',
      language: 'ar',
      authorName: 'ليلى الحسن',
      country: 'AE',
      variantTitle: 'عبوة 50 مل',
      verified: true,
      createdAt: '2026-05-30T17:29:00.000Z',
      ageRange: '35_44',
      skinConcerns: ['sensitivity', 'fine_lines'],
      timeUsing: 'm3_6',
      resultsSeen: ['radiance', 'fewer_lines'],
      helpfulCount: 11,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0018',
      rating: 4,
      title: 'نتائج جيدة مع الاستخدام المنتظم',
      body: 'بعد شهرين من الاستخدام المنتظم لاحظت أن بشرتي أصبحت مشدودة أكثر وملمسها أنعم. قوامه غني لكنه يمتص بسرعة. السعر مرتفع قليلاً لكن الجودة تستحق.',
      language: 'ar',
      authorName: 'نور الخالدي',
      country: 'SA',
      variantTitle: 'عبوة 50 مل',
      verified: true,
      createdAt: '2026-06-25T22:14:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['firmness', 'texture'],
      timeUsing: 'm1_3',
      resultsSeen: ['firmer', 'smoother'],
      helpfulCount: 8,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0019',
      rating: 5,
      title: 'At 67, my skin looks ten years younger',
      body: 'I never write reviews but this deserves one. I am 67 and my skin had gotten thin, dry and dull. Six months with this cream and the difference is remarkable — deeply moisturized, noticeably firmer around my cheeks, and people keep telling me I look rested. My hydration lasts through the night for the first time in years.',
      language: 'en',
      authorName: 'Rosalind Baker',
      country: 'US',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-01-22T15:42:00.000Z',
      ageRange: '65_plus',
      skinConcerns: ['dryness', 'firmness', 'dullness'],
      timeUsing: 'gt_6m',
      resultsSeen: ['firmer', 'radiance', 'hydration'],
      helpfulCount: 33,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0020',
      rating: 4,
      title: 'Feather-light and truly non-greasy',
      body: 'Most anti-aging creams feel like wearing a mask. This one is feather-light — honestly weightless once it settles — and leaves absolutely no greasy residue, even in humid weather. I use it every morning under SPF with no pilling. Four stars only because I am six weeks in and still waiting on the line-smoothing results.',
      language: 'en',
      authorName: 'Teresa Alvarez',
      country: 'US',
      variantTitle: '1.7 Fl Oz (Pack of 1)',
      verified: true,
      createdAt: '2026-06-17T09:53:00.000Z',
      ageRange: '35_44',
      skinConcerns: ['fine_lines', 'texture'],
      timeUsing: 'm1_3',
      resultsSeen: ['smoother'],
      helpfulCount: 14,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0021',
      rating: 5,
      title: 'Dark spots visibly faded',
      body: 'I bought this for fine lines but the surprise win was my dark spots. Three months of consistent use and the sun spots on my cheekbones have faded noticeably — my tone is the most even it has been in a decade. It is moisturizing without being heavy and plays well with my vitamin C serum.',
      language: 'en',
      authorName: 'Aisha Thompson',
      country: 'US',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-03-25T19:08:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['dark_spots', 'fine_lines'],
      timeUsing: 'm3_6',
      resultsSeen: ['even_tone', 'radiance'],
      helpfulCount: 26,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0022',
      rating: 3,
      title: 'Jury’s still out',
      body: 'Only two weeks in, so it is too early for a real verdict. The cream feels pleasant and hydrating, though I did get a couple of small breakouts along my hairline the first week — they have since calmed down. No visible change in my lines yet, which is expected. I will update this review after a couple of months.',
      language: 'en',
      authorName: 'Kelly Nguyen',
      country: 'US',
      variantTitle: '1.7 Fl Oz (Pack of 1)',
      verified: false,
      createdAt: '2026-07-11T23:17:00.000Z',
      ageRange: '25_34',
      skinConcerns: ['fine_lines', 'pores'],
      timeUsing: 'w1_4',
      resultsSeen: ['too_early'],
      helpfulCount: 5,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0023',
      rating: 1,
      title: 'Caused irritation for me',
      body: 'Unfortunately this did not work for my extremely reactive skin. Within three days I had stinging and visible redness along my cheeks, so I had to stop. I recognize I am an edge case — my skin reacts to most actives — but if you are highly sensitive, patch-test carefully first. Customer service was responsive when I reached out.',
      language: 'en',
      authorName: 'Dana R.',
      country: 'US',
      variantTitle: '1.7 Fl Oz (Pack of 1)',
      verified: true,
      createdAt: '2026-02-27T16:36:00.000Z',
      ageRange: '55_64',
      skinConcerns: ['sensitivity', 'redness'],
      timeUsing: 'lt_1w',
      resultsSeen: ['too_early'],
      helpfulCount: 19,
      reply: 'Thank you for the careful patch-testing advice, Dana, and we are truly sorry the formula did not suit your skin. Our care team has processed your full refund. — The Cellexia Care Team',
      replyAt: '2026-02-28T10:02:00.000Z',
      media: []
    },
    {
      id: 'demo-0024',
      rating: 5,
      title: 'A jar lasts forever — great value',
      body: 'Sticker shock is real, but hear me out: I bought this jar in March and I am still only halfway through in July, using it nightly. A pea-sized amount covers my whole face. My skin is smoother and my laugh lines are softer, and the cream never feels greasy. Cost per use, it is genuinely great value — cheaper than the three mediocre creams it replaced.',
      language: 'en',
      authorName: 'Helen Zhao',
      country: 'US',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-07-05T12:58:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['fine_lines', 'texture'],
      timeUsing: 'm3_6',
      resultsSeen: ['smoother', 'fewer_lines'],
      helpfulCount: 47,
      reply: null,
      replyAt: null,
      media: [media('demo-m-0024a', 'IMAGE', '#E8F1EF', '#9FC8BE')]
    },
    {
      id: 'demo-0025',
      rating: 5,
      title: 'Fragrance-free perfection for reactive skin',
      body: 'As someone with rosacea-prone skin, fragrance-free is not a preference — it is a requirement. This cream is beautifully unscented, gentle, and calming. My redness has visibly settled since I started it, and it delivers serious hydration without a hint of grease. Gentle enough that I sometimes use it on my eyelids.',
      language: 'en',
      authorName: 'Marianne Dubois',
      country: 'CA',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-04-02T14:25:00.000Z',
      ageRange: '55_64',
      skinConcerns: ['sensitivity', 'redness', 'dryness'],
      timeUsing: 'm3_6',
      resultsSeen: ['calmer', 'hydration'],
      helpfulCount: 21,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0026',
      rating: 4,
      title: 'Noticeably smoother texture in a month',
      body: 'My skin texture was my main concern — rough patches and an uneven feel along my jaw. Within a month of twice-daily use everything feels smoother and looks more refined. It has not done much for my deeper lines yet, hence four stars, but for surface texture it is the best thing I have tried.',
      language: 'en',
      authorName: 'Susan Pratt',
      country: 'GB',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-05-08T17:31:00.000Z',
      ageRange: '45_54',
      skinConcerns: ['texture', 'pores'],
      timeUsing: 'm1_3',
      resultsSeen: ['smoother'],
      helpfulCount: 10,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0027',
      rating: 5,
      title: 'Plumper, dewier skin in two weeks',
      body: 'Two weeks in and my skin already looks plumper and dewier. The hydration is intense but the finish is velvet, not greasy. My makeup sits better and that tight afternoon feeling is gone. I cannot wait to see the three-month mark.',
      language: 'en',
      authorName: 'Olivia Grant',
      country: 'US',
      variantTitle: null,
      verified: true,
      createdAt: '2026-07-20T11:19:00.000Z',
      ageRange: '25_34',
      skinConcerns: ['dryness', 'dullness'],
      timeUsing: 'w1_4',
      resultsSeen: ['hydration', 'radiance'],
      helpfulCount: 2,
      reply: null,
      replyAt: null,
      media: []
    },
    {
      id: 'demo-0028',
      rating: 5,
      title: 'Eight months in — still impressed',
      body: 'Long-term update: I have repurchased three times since November. My skin stays comfortable through winter heating and summer sun, the crow’s feet at my eyes are visibly softer, and the firmness along my jaw has genuinely improved. For a premium cream, the results justify the price several times over.',
      language: 'en',
      authorName: 'Barbara Steele',
      country: 'US',
      variantTitle: '50 mL Jar',
      verified: true,
      createdAt: '2026-07-14T08:05:00.000Z',
      ageRange: '65_plus',
      skinConcerns: ['fine_lines', 'firmness'],
      timeUsing: 'gt_6m',
      resultsSeen: ['fewer_lines', 'firmer', 'hydration'],
      helpfulCount: 63,
      reply: null,
      replyAt: null,
      media: []
    }
  ];

  /* ------------------------------------------------------------------ *
   * Media gallery (≤ 12 items, §6 shape)
   * ------------------------------------------------------------------ */

  var mediaGallery = [];
  reviews.forEach(function (r) {
    (r.media || []).forEach(function (m) {
      if (mediaGallery.length < 12) {
        mediaGallery.push({
          reviewId: r.id,
          type: m.type,
          url: m.url,
          thumbUrl: m.thumbUrl,
          authorName: r.authorName,
          rating: r.rating
        });
      }
    });
  });

  /* ------------------------------------------------------------------ *
   * AI summary + 8 topics (§6/§7 TopicJSON shape, incl. reviewIds)
   * ------------------------------------------------------------------ */

  var summary = {
    locale: 'en',
    text: 'Customers say this cream delivers deep, long-lasting hydration with a silky texture that absorbs quickly and never feels greasy. Many with sensitive skin praise the gentle, fragrance-free formula, and most report smoother, firmer, more radiant skin within weeks. Some customers with combination or oily skin mention clogged pores or breakouts, and a few feel the price is high for the jar size.',
    topics: [
      {
        key: 'moisturizing',
        label: 'Moisturizing',
        count: 2800,
        pos: 2650,
        neg: 150,
        sentiment: 'positive',
        blurb: 'Customers love how moisturizing this cream is, saying hydration lasts all day and through the night without feeling heavy.',
        terms: ['moistur', 'hydrat'],
        reviewIds: ['demo-0001', 'demo-0002', 'demo-0007', 'demo-0013', 'demo-0019', 'demo-0025', 'demo-0027']
      },
      {
        key: 'texture',
        label: 'Texture',
        count: 937,
        pos: 835,
        neg: 102,
        sentiment: 'positive',
        blurb: 'Customers praise the silky, cushiony texture that absorbs quickly, though a few find it too rich for oily skin.',
        terms: ['texture', 'silky'],
        reviewIds: ['demo-0002', 'demo-0003', 'demo-0008', 'demo-0018', 'demo-0026']
      },
      {
        key: 'skin_compatibility',
        label: 'Skin compatibility',
        count: 789,
        pos: 748,
        neg: 41,
        sentiment: 'positive',
        blurb: 'Customers with sensitive or reactive skin say the fragrance-free formula is gentle and calming, with very few reporting irritation.',
        terms: ['sensitive', 'gentle', 'irritat'],
        reviewIds: ['demo-0004', 'demo-0009', 'demo-0014', 'demo-0015', 'demo-0017', 'demo-0023', 'demo-0025']
      },
      {
        key: 'lightweight',
        label: 'Lightweight',
        count: 570,
        pos: 552,
        neg: 18,
        sentiment: 'positive',
        blurb: 'Customers describe the cream as feather-light and weightless once absorbed, comfortable under sunscreen and makeup.',
        terms: ['lightweight', 'weightless', 'feather-light'],
        reviewIds: ['demo-0002', 'demo-0006', 'demo-0011', 'demo-0016', 'demo-0020']
      },
      {
        key: 'non_greasy',
        label: 'Non-greasy',
        count: 555,
        pos: 541,
        neg: 14,
        sentiment: 'positive',
        blurb: 'Customers appreciate that it leaves no greasy residue or film, even in humid weather or under makeup.',
        terms: ['greasy', 'grease', 'residue'],
        reviewIds: ['demo-0002', 'demo-0006', 'demo-0013', 'demo-0020', 'demo-0024', 'demo-0025']
      },
      {
        key: 'value',
        label: 'Value for money',
        count: 492,
        pos: 411,
        neg: 81,
        sentiment: 'positive',
        blurb: 'Many customers say a little goes a long way and the jar outlasts expectations, though some find the price high.',
        terms: ['value', 'price', 'worth'],
        reviewIds: ['demo-0003', 'demo-0012', 'demo-0018', 'demo-0024', 'demo-0028']
      },
      {
        key: 'fragrance_free',
        label: 'Fragrance-free',
        count: 428,
        pos: 417,
        neg: 11,
        sentiment: 'positive',
        blurb: 'Customers value the completely fragrance-free formula, especially those with sensitive skin — a few miss having a light scent.',
        terms: ['fragrance', 'scent', 'unscented'],
        reviewIds: ['demo-0004', 'demo-0011', 'demo-0014', 'demo-0017', 'demo-0025']
      },
      {
        key: 'pore_clogging',
        label: 'Pore clogging',
        count: 510,
        pos: 72,
        neg: 438,
        sentiment: 'negative',
        blurb: 'Some customers report clogged pores or small breakouts, particularly on combination or oily skin, and recommend patch-testing first.',
        terms: ['clog', 'breakout', 'pore'],
        reviewIds: ['demo-0005', 'demo-0010', 'demo-0022']
      }
    ]
  };

  /* ------------------------------------------------------------------ *
   * Canned translations — POST /translate payload shape per id/target
   * (English targets for every non-English review, so "Translate" and
   * "Translate all reviews" work fully offline.)
   * ------------------------------------------------------------------ */

  var translations = {
    'demo-0007': {
      en: {
        title: 'Exceptional hydration',
        body: 'I have been using it morning and night for two months and my complexion is transformed. The cream is rich yet absorbs quickly, and the hydration lasts all day. The fine lines around my eyes are visibly softened. It has become the essential step in my routine.',
        reply: null
      }
    },
    'demo-0008': {
      en: {
        title: 'Very good cream, perfect texture',
        body: 'The texture is perfect: neither greasy nor sticky, it leaves skin soft and smooth. After six weeks my skin is firmer and more radiant. One star off because I would have liked a bigger jar, but I will definitely repurchase.',
        reply: null
      }
    },
    'demo-0009': {
      en: {
        title: 'My sensitive skin loves it',
        body: 'Finally an anti-aging cream without fragrance that does not irritate my reactive skin. It soothes redness and hydrates deeply with no greasy feel. After three months of use, my skin is calmer and more supple than it has been in years.',
        reply: null
      }
    },
    'demo-0010': {
      en: {
        title: 'Finally visible results',
        body: 'I have been using the cream for four months and I am delighted. It absorbs quickly, does not clog pores and leaves no oily film. My skin looks firmer and the fine lines on my forehead have become noticeably softer. It also holds up wonderfully under make-up.',
        reply: 'Thank you very much for your wonderful feedback, Ms Hoffmann! We are delighted that you are seeing visible results. — Your Cellexia Team'
      }
    },
    'demo-0011': {
      en: {
        title: 'Very pleasant, though I miss a light scent',
        body: 'The cream is wonderfully light and reliably cares for dry skin. After six weeks my skin feels smoother. The fact that it is completely fragrance-free is certainly good for sensitive skin — personally I miss a subtle scent, hence one star off.',
        reply: null
      }
    },
    'demo-0012': {
      en: {
        title: 'Good, but expensive',
        body: 'The quality is undeniably good; the cream absorbs quickly and moisturizes properly. For the price, however, I would have expected clearer results. After two months I only see minor changes. The value for money does not entirely convince me yet.',
        reply: null
      }
    },
    'demo-0013': {
      en: {
        title: 'My skin has never been so hydrated',
        body: 'I have been using it for ten weeks and my skin is more radiant, soft and hydrated than ever. The texture is wonderful: rich but not at all greasy, it absorbs right away. My little sun spots look faded and my skin tone is much more even.',
        reply: null
      }
    },
    'demo-0014': {
      en: {
        title: 'Perfect for sensitive skin, fragrance-free',
        body: 'I have very sensitive skin and almost everything irritates it. Being fragrance-free, this cream has not caused me a single reaction. It calms redness and leaves my skin soft and comfortable all day. After two months, my skin is visibly calmer.',
        reply: null
      }
    },
    'demo-0015': {
      en: {
        title: 'My skin is plumper and my makeup applies so much better',
        body: 'I have been using it for three months now. Despite the rich texture it is not sticky, and the moisturizing effect lasts until morning. The fine lines around my eyes are less noticeable and my makeup applies far better. I have sensitive skin but have had no irritation at all.',
        reply: null
      }
    },
    'demo-0016': {
      en: {
        title: 'Love the lightweight feel',
        body: 'The texture is very light and feels smooth right after applying. I am gradually seeing an effect on my dryness lines, but no dramatic change yet. I also feel reassured that it contains no fragrance. I will keep using it a while longer.',
        reply: null
      }
    },
    'demo-0017': {
      en: {
        title: 'The best cream I have tried for my skin',
        body: 'I have been using it for three months and my skin has become more radiant and smooth. The cream is fragrance-free and causes no irritation to my sensitive skin, and it moisturizes deeply without a greasy feel. The fine lines around my eyes are less visible.',
        reply: null
      }
    },
    'demo-0018': {
      en: {
        title: 'Good results with regular use',
        body: 'After two months of regular use I noticed my skin has become firmer and its texture smoother. The consistency is rich but absorbs quickly. The price is a little high, but the quality is worth it.',
        reply: null
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * v1.9 (SPEC-1.9 §1/§6): brand-wide payload for the "Overall reviews"
   * block — the shape of GET /apps/cellexia/api/brand-reviews:
   *   { stats: ShopStatsDTO, reviews: [ReviewDTO & { product }] }
   *
   * stats = { average, count, verifiedPercent, distribution } — the same
   * numbers the block SSRs from the `cellexia.shop_rating` shop metafield
   * (4.8 · 12,438 reviews · 93% verified; distribution percents via
   * largest remainder, counts sum to 12,438 and weight to 4.8).
   *
   * reviews = the candidate pool ACROSS ALL star levels, ordered by the
   * §1 auto score. The first six (all rating ≥ 4, max 2 per product —
   * the diversity rule) are the same six cards the demo page SSRs; the
   * lower-rated tail exists so the distribution-bar filter (?stars=N)
   * has real content to show for 1–3 star clicks. Each entry is a full
   * BrandReviewDTO (ReviewDTO plus `product: { title, handle, url }`)
   * with the metafield-entry field `productReviewCount` on top —
   * initOverall's buildCard accepts both shapes and needs that count for
   * the "Read [[count]] reviews" footer link.
   * ------------------------------------------------------------------ */

  var brandProducts = {
    cream: {
      title: 'Régénérant Cellular Renewal Cream',
      handle: 'regenerant-cellular-renewal-cream',
      url: '/products/regenerant-cellular-renewal-cream',
      reviewCount: 6214
    },
    serum: {
      title: 'Éclat Vitamin C Serum',
      handle: 'eclat-vitamin-c-serum',
      url: '/products/eclat-vitamin-c-serum',
      reviewCount: 2861
    },
    balm: {
      title: 'Hydra-Riche Night Balm',
      handle: 'hydra-riche-night-balm',
      url: '/products/hydra-riche-night-balm',
      reviewCount: 1940
    },
    eye: {
      title: 'Lumière Eye Contour Gel',
      handle: 'lumiere-eye-contour-gel',
      url: '/products/lumiere-eye-contour-gel',
      reviewCount: 1423
    }
  };

  var brand = {
    stats: {
      average: 4.8,
      count: 12438,
      verifiedPercent: 93,
      distribution: {
        '5': { count: 11000, percent: 89 },
        '4': { count: 900, percent: 7 },
        '3': { count: 300, percent: 2 },
        '2': { count: 100, percent: 1 },
        '1': { count: 138, percent: 1 }
      }
    },
    reviews: [
      {
        id: 'brand-0001',
        rating: 5,
        title: 'The only cream that actually changed my skin',
        body: 'I am 58 and I have tried more face creams than I care to admit. This is the first one that changed the texture of my skin instead of just sitting on it. The cream is rich but absorbs in under a minute, so I can apply makeup right after. Within two weeks my cheeks felt smoother, and by the two-month mark the crepey texture along my jawline had visibly improved — my dermatologist commented on it unprompted. It is fragrance-free, which my reactive skin appreciates, and one jar has lasted almost three months of twice-daily use. I have already ordered a second jar and convinced my sister to start too.',
        language: 'en',
        authorName: 'Margaret Ellison',
        country: 'US',
        variantTitle: '50 mL Jar',
        verified: true,
        createdAt: '2026-07-06T14:02:00.000Z',
        ageRange: '55_64',
        skinConcerns: ['fine_lines', 'texture'],
        timeUsing: 'm3_6',
        resultsSeen: ['smoother', 'fewer_lines', 'firmer'],
        helpfulCount: 214,
        reply: null,
        replyAt: null,
        media: [media('brand-m-0001a', 'IMAGE', '#EFE3D0', '#D9BE93')],
        productReviewCount: brandProducts.cream.reviewCount,
        product: brandProducts.cream
      },
      {
        id: 'brand-0002',
        rating: 5,
        title: 'Glow in under two weeks',
        body: 'The vitamin C serum my morning routine was missing. No sting, no orange cast — just a steady, healthy glow that friends started noticing before I did. A gentle tingle the first few days, then nothing but brightness. My dark spots from last summer are already softer at the edges, and it layers under sunscreen without a hint of pilling.',
        language: 'en',
        authorName: 'Aisha Thompson',
        country: 'US',
        variantTitle: '30 mL',
        verified: true,
        createdAt: '2026-07-12T09:41:00.000Z',
        ageRange: '45_54',
        skinConcerns: ['dark_spots', 'dullness'],
        timeUsing: 'm1_3',
        resultsSeen: ['radiance', 'even_tone'],
        helpfulCount: 158,
        reply: null,
        replyAt: null,
        media: [],
        productReviewCount: brandProducts.serum.reviewCount,
        product: brandProducts.serum
      },
      {
        id: 'brand-0003',
        rating: 5,
        title: 'Softer skin by morning, every morning',
        body: 'I smooth it on as the last step at night and wake up with skin that feels rested and plush. It is a proper balm — thick in the jar, melting on contact — yet my pillow stays clean. Through a dry winter and an air-conditioned summer it has kept every trace of flaking away, and my makeup sits noticeably better the next day.',
        language: 'en',
        authorName: 'Claire Whitmore',
        country: 'GB',
        variantTitle: '50 mL Jar',
        verified: true,
        createdAt: '2026-06-28T21:17:00.000Z',
        ageRange: '45_54',
        skinConcerns: ['dryness', 'dullness'],
        timeUsing: 'm3_6',
        resultsSeen: ['hydration', 'smoother'],
        helpfulCount: 121,
        reply: null,
        replyAt: null,
        media: [media('brand-m-0003a', 'IMAGE', '#D9E7F5', '#A9C6E8')],
        productReviewCount: brandProducts.balm.reviewCount,
        product: brandProducts.balm
      },
      {
        id: 'brand-0004',
        rating: 5,
        title: 'Sensitive skin approved — zero irritation',
        body: 'My skin flares at almost everything, so I patch-tested for a week first. Not a single reaction since — no sting, no redness, just calm, deeply hydrated skin. Three months in, my barrier feels stronger than it has in years and the tight feeling I used to get by mid-afternoon is simply gone.',
        language: 'en',
        authorName: 'Ruth Calloway',
        country: 'US',
        variantTitle: '50 mL Jar',
        verified: true,
        createdAt: '2026-07-18T08:29:00.000Z',
        ageRange: '45_54',
        skinConcerns: ['sensitivity', 'redness'],
        timeUsing: 'm3_6',
        resultsSeen: ['calmer', 'hydration'],
        helpfulCount: 96,
        reply: null,
        replyAt: null,
        media: [],
        productReviewCount: brandProducts.cream.reviewCount,
        product: brandProducts.cream
      },
      {
        id: 'brand-0005',
        rating: 5,
        title: 'Dark circles visibly brighter',
        body: 'Two pumps every morning under concealer. Within a month the shadows under my eyes were light enough that most days I skip the concealer entirely. It is cooling, sinks in fast and never pills under sunscreen — the first eye product I have finished to the last drop.',
        language: 'en',
        authorName: 'Sofia Marchetti',
        country: 'IT',
        variantTitle: '15 mL',
        verified: true,
        createdAt: '2026-07-01T17:55:00.000Z',
        ageRange: '35_44',
        skinConcerns: ['dark_circles', 'fine_lines'],
        timeUsing: 'm1_3',
        resultsSeen: ['radiance', 'even_tone'],
        helpfulCount: 88,
        reply: null,
        replyAt: null,
        media: [media('brand-m-0005a', 'IMAGE', '#E5DFF2', '#BCA9DD')],
        productReviewCount: brandProducts.eye.reviewCount,
        product: brandProducts.eye
      },
      {
        id: 'brand-0006',
        rating: 4,
        title: 'Lovely serum — give it time',
        body: 'Four stars for now, only because vitamin C rewards patience: six weeks in, my tone is more even and my forehead looks brighter, but the deeper spots are still fading. The texture is perfect — watery-light, layers under anything, no scent. I will update at the three-month mark.',
        language: 'en',
        authorName: 'Hannah Ostrowski',
        country: 'CA',
        variantTitle: '30 mL',
        verified: true,
        createdAt: '2026-06-20T12:03:00.000Z',
        ageRange: '35_44',
        skinConcerns: ['dark_spots', 'texture'],
        timeUsing: 'm1_3',
        resultsSeen: ['even_tone', 'radiance'],
        helpfulCount: 64,
        reply: null,
        replyAt: null,
        media: [],
        productReviewCount: brandProducts.serum.reviewCount,
        product: brandProducts.serum
      },
      {
        id: 'brand-0007',
        rating: 4,
        title: 'Rich but worth it',
        body: 'Almost too rich for my combination skin in summer, so I use it every other night — and on that schedule it is wonderful: no tightness by morning and a soft, even feel that lasts all day. Come winter I expect to use it nightly.',
        language: 'en',
        authorName: 'Laura Bennett',
        country: 'US',
        variantTitle: '50 mL Jar',
        verified: false,
        createdAt: '2026-07-15T19:26:00.000Z',
        ageRange: '25_34',
        skinConcerns: ['dryness', 'texture'],
        timeUsing: 'm1_3',
        resultsSeen: ['hydration'],
        helpfulCount: 23,
        reply: null,
        replyAt: null,
        media: [],
        productReviewCount: brandProducts.balm.reviewCount,
        product: brandProducts.balm
      },
      {
        id: 'brand-0008',
        rating: 3,
        title: 'Pleasant, but subtle',
        body: 'After two months of twice-daily use the gel feels lovely going on — cool and weightless — but the change in my dark circles is subtle at best. Fine if you want gentle maintenance; temper your expectations if you are hoping for more.',
        language: 'en',
        authorName: 'Denise Park',
        country: 'US',
        variantTitle: '15 mL',
        verified: true,
        createdAt: '2026-06-05T10:48:00.000Z',
        ageRange: '45_54',
        skinConcerns: ['dark_circles'],
        timeUsing: 'm1_3',
        resultsSeen: ['too_early'],
        helpfulCount: 31,
        reply: null,
        replyAt: null,
        media: [],
        productReviewCount: brandProducts.eye.reviewCount,
        product: brandProducts.eye
      },
      {
        id: 'brand-0009',
        rating: 2,
        title: 'Too rich for combination skin',
        body: 'Beautifully made cream, but by day ten I had congestion along my chin that I never normally get. Drier skin types will likely love it; my combination skin did not. The texture and the fragrance-free formula deserve credit all the same.',
        language: 'en',
        authorName: 'Mia Kowalczyk',
        country: 'PL',
        variantTitle: '50 mL Jar',
        verified: true,
        createdAt: '2026-05-22T15:12:00.000Z',
        ageRange: '25_34',
        skinConcerns: ['pores', 'texture'],
        timeUsing: 'w1_4',
        resultsSeen: ['too_early'],
        helpfulCount: 44,
        reply: 'We are sorry the cream did not agree with your skin, Mia. Régénérant is rich by design — on combination skin we recommend a thin layer at night only. Please contact care@cellexia.com and we will happily arrange a refund. — The Cellexia Care Team',
        replyAt: '2026-05-23T09:05:00.000Z',
        media: [],
        productReviewCount: brandProducts.cream.reviewCount,
        product: brandProducts.cream
      },
      {
        id: 'brand-0010',
        rating: 1,
        title: 'My skin reacted, sadly',
        body: 'Within three days of starting the serum I had stinging and blotchy redness across my cheeks and had to stop. I seem to be the exception judging by the other reviews, but if your skin is very reactive, patch-test first. Customer service refunded me quickly and kindly.',
        language: 'en',
        authorName: 'Karen Mitchell',
        country: 'US',
        variantTitle: '30 mL',
        verified: true,
        createdAt: '2026-04-30T18:37:00.000Z',
        ageRange: '55_64',
        skinConcerns: ['sensitivity', 'redness'],
        timeUsing: 'lt_1w',
        resultsSeen: ['too_early'],
        helpfulCount: 17,
        reply: 'Thank you for the patch-testing advice, Karen, and we are truly sorry the serum did not suit your skin — vitamin C can be demanding on very reactive skin. Your refund has been processed. — The Cellexia Care Team',
        replyAt: '2026-05-01T08:52:00.000Z',
        media: [],
        productReviewCount: brandProducts.serum.reviewCount,
        product: brandProducts.serum
      }
    ]
  };

  /* ------------------------------------------------------------------ *
   * Assemble — same top-level shape as GET /apps/cellexia/api/reviews,
   * plus `translations` for the offline translate endpoint.
   * ------------------------------------------------------------------ */

  window.CellexiaDemoData = {
    product: {
      id: '8654321098765',
      title: 'Cellexia Régénérant Cellular Renewal Cream',
      average: 4.6,
      count: 50506,
      distribution: {
        '5': { count: 40910, percent: 81 },
        '4': { count: 5051, percent: 10 },
        '3': { count: 2525, percent: 5 },
        '2': { count: 505, percent: 1 },
        '1': { count: 1515, percent: 3 }
      }
    },
    summary: summary,
    reviews: reviews,
    media_gallery: mediaGallery,
    page: 1,
    per_page: 10,
    total: reviews.length,
    total_pages: Math.ceil(reviews.length / 10),
    translations: translations,

    /* v1.5 (SPEC-1.5 §2 + §3.4): the inner "badges" map of the response to
     * GET /apps/cellexia/api/badges?handles=…
     *   { "badges": { "<handle>": { "average": 4.6, "count": 128 } } }
     * In demo mode the widget's site-wide badge injector reads this map
     * instead of fetching, exactly like `summary`/`translations` above.
     * It drives the "product card grid" showcase in demo/index.html:
     * four of the six cards below have data; the other two handles
     * (purete-gentle-cleansing-foam — zero published reviews — and
     * velours-solaire-spf50) are intentionally ABSENT, because the real
     * endpoint omits handles without published reviews and their cards
     * must stay clean. */
    badges: {
      'regenerant-cellular-renewal-cream': { average: 4.6, count: 50506 },
      'eclat-vitamin-c-serum': { average: 4.8, count: 1234 },
      'hydra-riche-night-balm': { average: 4.2, count: 87 },
      'lumiere-eye-contour-gel': { average: 3.4, count: 412 }
    },

    /* v1.9 (SPEC-1.9 §1 + §6): GET /apps/cellexia/api/brand-reviews shape
     * for the "Overall reviews" showcase — see the `brand` block above.
     * initOverall's demo branch reads exactly this key. Like every showcase
     * section on the demo page, it is its own sample payload (the product
     * widget's 50,506-rating header, the badges map and this brand payload
     * are three independent mock datasets). */
    brand: brand
  };
})();
