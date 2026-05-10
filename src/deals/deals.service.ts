import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import axios from 'axios';

import { PrismaService } from '../prisma/prisma.service';
import { extractFirstSupportedUrl } from '../affiliate/url-detector';

const DEAL_SOURCE_ACCESSTRADE = 'accesstrade';
const DEAL_STATUS_NEW = 'NEW';
const DEAL_STATUS_APPROVED = 'APPROVED';
const DEAL_STATUS_REJECTED = 'REJECTED';

interface AccesstradeOffer {
  id?: unknown;
  merchant?: unknown;
  name?: unknown;
  content?: unknown;
  coupons?: unknown;
  domain?: unknown;
  image?: unknown;
  link?: unknown;
  aff_link?: unknown;
  start_time?: unknown;
  end_time?: unknown;
}

@Injectable()
export class DealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createDeal(input: {
    title: string;
    description?: string | null;
    merchant: string;
    originalUrl: string;
    createdByTelegramId?: number | bigint | null;
  }) {
    return this.prisma.deal.create({
      data: {
        title: input.title,
        description: input.description || null,
        merchant: input.merchant,
        originalUrl: input.originalUrl,
        createdByTelegramId:
          input.createdByTelegramId === undefined ||
          input.createdByTelegramId === null
            ? null
            : BigInt(input.createdByTelegramId),
      },
    });
  }

  async findActiveDeal(id: string) {
    return this.prisma.deal.findFirst({
      where: { id, isActive: true },
    });
  }

  async findByIdOrPrefix(idOrPrefix: string) {
    const exact = await this.prisma.deal.findUnique({
      where: { id: idOrPrefix },
    });
    if (exact) return exact;

    return this.prisma.deal.findFirst({
      where: { id: { startsWith: idOrPrefix } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listRecentDeals(limit = 10) {
    return this.prisma.deal.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async setActive(id: string, isActive: boolean) {
    return this.prisma.deal.update({
      where: { id },
      data: { isActive },
    });
  }

  async scanShopeeDealCandidates(input?: { limit?: number; page?: number }) {
    const token = this.config.get<string>('ACCESSTRADE_API_TOKEN')?.trim();
    if (!token) {
      throw new Error('Thiếu ACCESSTRADE_API_TOKEN để quét deal Accesstrade.');
    }

    const limit = clampInt(input?.limit ?? 30, 1, 50);
    const page = clampInt(input?.page ?? 1, 1, 50);
    const res = await axios.get(
      'https://api.accesstrade.vn/v1/offers_informations',
      {
        params: {
          domain: 'shopee.vn',
          status: 1,
          limit,
          page,
        },
        headers: { Authorization: `Token ${token}` },
        timeout: 30_000,
      },
    );

    const rawItems = Array.isArray(res.data?.data)
      ? (res.data.data as AccesstradeOffer[])
      : [];
    const result = {
      fetched: rawItems.length,
      created: 0,
      updated: 0,
      skipped: 0,
      candidates: [] as Array<{
        id: string;
        externalId: string;
        title: string;
        score: number;
        status: string;
      }>,
    };

    for (const raw of rawItems) {
      const normalized = normalizeAccesstradeOffer(raw);
      if (!normalized) {
        result.skipped += 1;
        continue;
      }

      const existing = await this.prisma.dealCandidate.findUnique({
        where: {
          source_externalId: {
            source: DEAL_SOURCE_ACCESSTRADE,
            externalId: normalized.externalId,
          },
        },
      });

      if (existing && existing.status !== DEAL_STATUS_NEW) {
        result.skipped += 1;
        result.candidates.push({
          id: existing.id,
          externalId: existing.externalId,
          title: existing.title,
          score: existing.score,
          status: existing.status,
        });
        continue;
      }

      const candidate = existing
        ? await this.prisma.dealCandidate.update({
            where: { id: existing.id },
            data: normalized,
          })
        : await this.prisma.dealCandidate.create({
            data: {
              ...normalized,
              source: DEAL_SOURCE_ACCESSTRADE,
            },
          });

      if (existing) result.updated += 1;
      else result.created += 1;
      result.candidates.push({
        id: candidate.id,
        externalId: candidate.externalId,
        title: candidate.title,
        score: candidate.score,
        status: candidate.status,
      });
    }

    return result;
  }

  async listDealCandidates(input?: { status?: string; limit?: number }) {
    const status = input?.status?.trim().toUpperCase() || DEAL_STATUS_NEW;
    const limit = clampInt(input?.limit ?? 10, 1, 50);
    return this.prisma.dealCandidate.findMany({
      where: { status },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }

  async findCandidateByIdOrPrefix(idOrPrefix: string) {
    const exact = await this.prisma.dealCandidate.findUnique({
      where: { id: idOrPrefix },
    });
    if (exact) return exact;

    return this.prisma.dealCandidate.findFirst({
      where: { id: { startsWith: idOrPrefix } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveCandidate(idOrPrefix: string, adminTelegramId: number | bigint) {
    const candidate = await this.findCandidateByIdOrPrefix(idOrPrefix);
    if (!candidate) throw new Error(`Không tìm thấy candidate ${idOrPrefix}`);
    if (candidate.status === DEAL_STATUS_REJECTED) {
      throw new Error('Candidate này đã bị reject. Bật lại thủ công trước nếu muốn gửi.');
    }

    if (candidate.status === DEAL_STATUS_APPROVED && candidate.dealId) {
      const existingDeal = await this.prisma.deal.findUnique({
        where: { id: candidate.dealId },
      });
      if (existingDeal) return { candidate, deal: existingDeal, alreadyApproved: true };
    }

    const deal = await this.createDeal({
      title: candidate.title,
      description: candidate.description,
      merchant: candidate.merchant,
      originalUrl: candidate.originalUrl,
      createdByTelegramId: adminTelegramId,
    });

    const updatedCandidate = await this.prisma.dealCandidate.update({
      where: { id: candidate.id },
      data: {
        status: DEAL_STATUS_APPROVED,
        dealId: deal.id,
        reviewedByTelegramId: BigInt(adminTelegramId),
        reviewedAt: new Date(),
      },
    });

    return { candidate: updatedCandidate, deal, alreadyApproved: false };
  }

  async rejectCandidate(idOrPrefix: string, adminTelegramId: number | bigint) {
    const candidate = await this.findCandidateByIdOrPrefix(idOrPrefix);
    if (!candidate) throw new Error(`Không tìm thấy candidate ${idOrPrefix}`);
    return this.prisma.dealCandidate.update({
      where: { id: candidate.id },
      data: {
        status: DEAL_STATUS_REJECTED,
        reviewedByTelegramId: BigInt(adminTelegramId),
        reviewedAt: new Date(),
      },
    });
  }
}

function normalizeAccesstradeOffer(raw: AccesstradeOffer) {
  const externalId = text(raw.id);
  const merchant = text(raw.merchant).toLowerCase();
  const originalUrl = normalizeShopeeUrl(text(raw.link));
  const sourceAffiliateUrl = normalizeUrl(text(raw.aff_link));
  const imageUrl = normalizeUrl(text(raw.image));
  const title = cleanText(text(raw.name));
  const content = cleanText(text(raw.content));
  const startAt = parseDate(text(raw.start_time));
  const endAt = parseDate(text(raw.end_time));

  if (!externalId || merchant !== 'shopee' || !originalUrl || !title) {
    return null;
  }
  if (!imageUrl) return null;
  if (endAt && endAt.getTime() < startOfToday().getTime()) return null;

  const couponText = summarizeCoupons(raw.coupons);
  const description = [couponText, content].filter(Boolean).join('\n');
  const score = scoreOffer({ title, description, imageUrl, endAt });

  return {
    externalId,
    merchant,
    title: title.slice(0, 240),
    description: description ? description.slice(0, 900) : null,
    originalUrl,
    imageUrl,
    sourceAffiliateUrl,
    startAt,
    endAt,
    status: DEAL_STATUS_NEW,
    score,
    rawPayload: toPrismaJson(raw),
  };
}

function toPrismaJson(value: unknown): InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as InputJsonValue;
}

function normalizeShopeeUrl(raw: string): string | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  const detected = extractFirstSupportedUrl(normalized);
  return detected?.merchant === 'shopee' ? detected.url : null;
}

function normalizeUrl(raw: string): string | null {
  const cleaned = raw.trim().replaceAll('&amp;', '&');
  if (!cleaned) return null;
  const withScheme = cleaned.startsWith('http') ? cleaned : `https://${cleaned}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

function summarizeCoupons(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const texts = raw
    .map((coupon) => {
      if (!coupon || typeof coupon !== 'object') return '';
      const values = Object.values(coupon as Record<string, unknown>)
        .map((value) => text(value))
        .filter(Boolean);
      return cleanText(values.join(' '));
    })
    .filter(Boolean)
    .slice(0, 2);
  return texts.length > 0 ? texts.join('\n') : null;
}

function scoreOffer(input: {
  title: string;
  description: string;
  imageUrl: string | null;
  endAt: Date | null;
}): number {
  let score = 50;
  if (input.imageUrl) score += 15;
  if (/giảm|giam|voucher|mã|ma|sale/i.test(input.title)) score += 15;
  if (/\b\d{2,3}[,.]?\d{3}\b|\b\d{1,3}%\b/.test(input.title)) score += 15;
  if (input.description) score += 5;
  if (input.endAt && input.endAt.getTime() > Date.now()) score += 10;
  return Math.min(score, 100);
}

function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
