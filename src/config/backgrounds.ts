interface BackgroundImage {
  url: string;
  title: string;
  artist: string;
  source: string;
  socials?: {
    name: string;
    link: string;
  }[];
}

export const backgrounds: BackgroundImage[] = [
  {
    url: "/citali.webp",
    title: "Citlali (Genshin Impact)",
    artist: "ryrmcher",
    source: "https://danbooru.donmai.us/posts/6148600",
    socials: [
      {
        name: "Twitter Post",
        link: "https://x.com/ryrmcher/status/1878812100866560258",
      },
      {
        name: "Artist's Twitter",
        link: "https://x.com/ryrmcher",
      },
    ],
  },
  {
    url: "/patchouli.webp",
    title: "ひとりぼっちのあさ",
    artist: "ayanagi0319",
    source: "https://danbooru.donmai.us/posts/6900673",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://twitter.com/ayanagi0319",
      },
    ],
  },
  {
    url: "/original.webp",
    title: "読書",
    artist: "kamepan44231 - かめぱすた",
    source: "https://danbooru.donmai.us/posts/8743208",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/kamepan44231",
      },
    ],
  },
  {
    url: "/numi.webp",
    title: "Numi",
    artist: "TenIllustrator",
    source: "https://danbooru.donmai.us/posts/8074444",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/Ten_0123_/",
      },
    ],
  },
  {
    url: "/shylily.webp",
    title: "Shylily",
    artist: "greatodoggo",
    source: "https://www.pixiv.net/en/artworks/124222053",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/greatodoggo",
      },
    ],
  },
  {
    url: "/sleepy.webp",
    title: "???",
    artist: "soaphisoap",
    source: "https://safebooru.org/index.php?page=post&s=view&id=5418793",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/soaphisoap",
      },
    ],
  },
  {
    url: "/genshin.webp",
    title: "???",
    artist: "charlieinoni",
    source: "https://safebooru.org/index.php?page=post&s=view&id=5531630",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/charlieinoni",
      },
    ],
  },
  {
    url: "/meata.webp",
    title: "???",
    artist: "???",
    source:
      "https://i.pximg.net/img-original/img/2025/03/03/15/13/24/127822472_p0.png",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/",
      },
    ],
  },
  {
    url: "/cynthia1.webp",
    title: "Cynthia (Pokemon)",
    artist: "???",
    source: "https://safebooru.org/index.php?page=post&s=view&id=5547740",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/",
      },
    ],
  },
  {
    url: "/darling.webp",
    title: "Zero Two",
    artist: "AWZ",
    source: "https://www.pixiv.net/en/artworks/123110068",
    socials: [
      {
        name: "Pixiv Profile",
        link: "https://www.pixiv.net/en/users/67355371",
      },
    ],
  },
  {
    url: "/granny.webp",
    title: "Turbo Granny (Dandadan)",
    artist: "MajimartBCN",
    source: "https://twitter.com/MajimartBCN/status/1864741369383694841",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/MajimartBCN",
      },
    ],
  },
  {
    url: "/numi_lily.webp",
    title: "Nihmune & Shylily",
    artist: "Gryever_AW",
    source: "https://x.com/gryever_aw/status/1890772686084686118",
    socials: [
      {
        name: "Artist's Twitter",
        link: "https://x.com/Gryever_AW",
      },
    ],
  },
  // Add more backgrounds here!
  // {
  //   url: 'your-image-url',
  //   title: 'Image Title',
  //   artist: 'Artist Name',
  //   source: 'source-url',
  //   socials: [
  //     { name: 'Twitter', link: 'twitter-url' }
  //   ]
  // }
];

export function getRandomBackground(): BackgroundImage {
  if (backgrounds.length === 0) {
    // Fallback background if array is empty
    return {
      url: "/citali.webp",
      title: "Citlali (Genshin Impact)",
      artist: "ryrmcher",
      source: "https://danbooru.donmai.us/posts/6148600",
      socials: [],
    };
  }
  return backgrounds[Math.floor(Math.random() * backgrounds.length)];
}

export function preloadBackgrounds() {
  backgrounds.forEach((bg) => {
    const img = new Image();
    img.src = bg.url;
  });
}
