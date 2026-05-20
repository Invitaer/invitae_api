import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export class InvitationMetadataDto {
  @IsString()
  slug: string;

  @IsString()
  eventType: string;

  @IsString()
  language: string;
}

export class InvitationThemeDto {
  @IsString()
  bgBase: string;

  @IsString()
  bgCard: string;

  @IsString()
  accent: string;

  @IsString()
  text: string;
}

export class InvitationAssetsDto {
  @IsOptional()
  @IsString()
  heroImage?: string | null;

  @IsOptional()
  @IsString()
  music?: string | null;
}

export class InvitationSettingsDto {
  @IsString()
  whatsappNumber: string;

  @IsString()
  mapsUrl: string;

  @IsBoolean()
  musicAutoplay: boolean;
}

// ── Section data DTOs ────────────────────────────────────────────────────────

export class HeroSectionDataDto {
  @IsString()
  celebrantNames: string;

  @IsString()
  eventType: string;

  @IsOptional()
  @IsString()
  subtitle?: string;

  @IsString()
  eventDate: string;

  @IsOptional()
  @IsString()
  backgroundImage?: string;
}

export class CountdownLabelsDto {
  @IsString()
  days: string;

  @IsString()
  hours: string;

  @IsString()
  minutes: string;

  @IsString()
  seconds: string;
}

export class CountdownSectionDataDto {
  @IsString()
  targetDate: string;

  @ValidateNested()
  @Type(() => CountdownLabelsDto)
  labels: CountdownLabelsDto;

  @IsString()
  finishedMessage: string;
}

export class TimelineItemDto {
  @IsString()
  year: string;

  @IsString()
  title: string;

  @IsString()
  text: string;
}

export class StorySectionDataDto {
  @IsString()
  title: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimelineItemDto)
  timelineItems: TimelineItemDto[];
}

export class ParentNamesDto {
  @IsString()
  mother: string;

  @IsString()
  father: string;
}

export class ParentsSectionDataDto {
  @IsString()
  title: string;

  @ValidateNested()
  @Type(() => ParentNamesDto)
  bride: ParentNamesDto;

  @ValidateNested()
  @Type(() => ParentNamesDto)
  groom: ParentNamesDto;

  @IsOptional()
  @IsString()
  message?: string;
}

export class GodparentItemDto {
  @IsString()
  category: string;

  @IsString()
  names: string;
}

export class GodparentsSectionDataDto {
  @IsString()
  title: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GodparentItemDto)
  godparents: GodparentItemDto[];
}

export class QuoteSectionDataDto {
  @IsString()
  quote: string;

  @IsOptional()
  @IsString()
  author?: string;
}

export class CeremonySectionDataDto {
  @IsString()
  place: string;

  @IsString()
  address: string;

  @IsString()
  time: string;

  @IsString()
  date: string;

  @IsOptional()
  @IsString()
  mapsUrl?: string;

  @IsOptional()
  @IsString()
  image?: string;
}

export class ReceptionSectionDataDto {
  @IsString()
  venue: string;

  @IsString()
  address: string;

  @IsString()
  time: string;

  @IsString()
  date: string;

  @IsOptional()
  @IsString()
  parking?: string;

  @IsOptional()
  @IsString()
  mapsUrl?: string;

  @IsOptional()
  @IsString()
  image?: string;
}

export class PartySectionDataDto {
  @IsString()
  location: string;

  @IsString()
  DJ: string;

  @IsString()
  startTime: string;

  @IsString()
  endTime: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class AgendaEventDto {
  @IsString()
  hour: string;

  @IsString()
  title: string;

  @IsString()
  description: string;
}

export class TimelineSectionDataDto {
  @IsString()
  title: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgendaEventDto)
  events: AgendaEventDto[];
}

export class DresscodeColorDto {
  @IsString()
  name: string;

  @IsString()
  hex: string;
}

export class DresscodeSectionDataDto {
  @IsString()
  mode: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DresscodeColorDto)
  colors: DresscodeColorDto[];

  @IsArray()
  @IsString({ each: true })
  restrictions: string[];
}

export class GalleryImageDto {
  @IsString()
  src: string;

  @IsOptional()
  @IsString()
  alt?: string;
}

export class GallerySectionDataDto {
  @IsString()
  title: string;

  @IsString()
  layout: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GalleryImageDto)
  images: GalleryImageDto[];
}

export class VideoSectionDataDto {
  @IsString()
  title: string;

  @IsString()
  videoUrl: string;

  @IsOptional()
  @IsString()
  poster?: string;
}

export class HotelDto {
  @IsString()
  name: string;

  @IsNumber()
  stars: number;

  @IsString()
  distance: string;

  @IsString()
  phone: string;

  @IsString()
  address: string;
}

export class HotelDiscountDto {
  @IsString()
  hotel: string;

  @IsString()
  code: string;

  @IsString()
  discount: string;
}

export class AccommodationSectionDataDto {
  @IsString()
  title: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HotelDto)
  hotels: HotelDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HotelDiscountDto)
  discounts?: HotelDiscountDto[];
}

export class ShuttleInfoDto {
  @IsBoolean()
  enabled: boolean;

  @IsString()
  departure: string;

  @IsString()
  return: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class TransportationSectionDataDto {
  @ValidateNested()
  @Type(() => ShuttleInfoDto)
  shuttleInfo: ShuttleInfoDto;

  @IsOptional()
  @IsString()
  parking?: string;

  @IsOptional()
  @IsString()
  uberCode?: string;
}

export class GiftStoreDto {
  @IsString()
  name: string;

  @IsString()
  detail: string;

  @IsOptional()
  @IsString()
  url?: string;
}

export class BankAccountDto {
  @IsString()
  bank: string;

  @IsString()
  clabe: string;

  @IsString()
  beneficiary: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class GiftRegistrySectionDataDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GiftStoreDto)
  stores: GiftStoreDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => BankAccountDto)
  bankAccount?: BankAccountDto;
}

export class RsvpSectionDataDto {
  @IsBoolean()
  enabled: boolean;

  @IsString()
  deadline: string;

  @IsNumber()
  maxGuests: number;

  @IsString()
  whatsappNumber: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class FaqItemDto {
  @IsString()
  q: string;

  @IsString()
  a: string;
}

export class FaqSectionDataDto {
  @IsString()
  title: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  questions: FaqItemDto[];
}

export class SocialWallSectionDataDto {
  @IsString()
  hashtag: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  instagramHandle?: string;

  @IsOptional()
  @IsArray()
  instagramFeed?: string[];
}

export class SocialLinkDto {
  @IsString()
  platform: string;

  @IsString()
  url: string;
}

export class FooterSectionDataDto {
  @IsString()
  hashtag: string;

  @IsOptional()
  @IsString()
  thankYouMessage?: string;

  @IsString()
  coupleNames: string;

  @IsString()
  year: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  socialLinks?: SocialLinkDto[];
}

// ── Section wrapper ──────────────────────────────────────────────────────────

export class InvitationSectionDto {
  @IsString()
  type: string;

  @IsBoolean()
  enabled: boolean;

  @IsNumber()
  order: number;

  @IsObject()
  data: Record<string, any>;
}

// ── Root DTO ─────────────────────────────────────────────────────────────────

export class InvitationDto {
  @ValidateNested()
  @Type(() => InvitationMetadataDto)
  metadata: InvitationMetadataDto;

  @ValidateNested()
  @Type(() => InvitationThemeDto)
  theme: InvitationThemeDto;

  @ValidateNested()
  @Type(() => InvitationAssetsDto)
  assets: InvitationAssetsDto;

  @ValidateNested()
  @Type(() => InvitationSettingsDto)
  settings: InvitationSettingsDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvitationSectionDto)
  sections: InvitationSectionDto[];
}
