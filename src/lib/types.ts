export interface Comic {
  id: string;
  chap: string;
  updated_at: string;
  md_comics: {
    title: string;
    slug: string;
    genres: number[];
    md_covers: ComicCover[];
    content_rating: 'safe' | 'suggestive' | 'erotica';
    comic_type: ComicType;
  };
}

export interface Genre {
  id: number;
  name: string;
}

export interface FeedMapping {
  slugs: string[];
  lang: string;
}

export type ComicType = 'manga' | 'manhwa' | 'manhua' | 'all';

export interface ComicCover {
  b2key: string;
  width?: number;
  height?: number;
}

export interface Announcement {
  message: string;
  type: 'info' | 'warning' | 'success';
  dismissible?: boolean;
  link?: {
    text: string;
    url: string;
  };
}

export interface ChapterDetail {
  id: string;
  chap: string;
  title: string;
  created_at: string;
  md_comics: {
    title: string;
    slug: string;
    md_covers?: ComicCover[];
  };
}