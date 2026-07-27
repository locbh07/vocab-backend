import { Request, Response, Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireUser, UserIdentity } from '../middleware/userGuard';
import { hasActivePremium } from '../lib/contentAccess';
import {
  buildBookStoragePath,
  coverStorageKeyFor,
  createDownloadSignedUrl,
  createUploadSignedUrl,
  deleteStorageObjects,
  headObjectSize,
  pageStorageKeyFor,
} from '../lib/bookStorage';

const MAX_FILE_SIZE_BYTES = 150 * 1024 * 1024;
const MAX_PAGE_COUNT = 2000;

type BookWithUploader = {
  id: bigint;
  title: string;
  description: string | null;
  fileName: string;
  fileSize: number;
  pageCount: number | null;
  isPremiumOnly: boolean;
  coverStoragePath: string | null;
  pagesCached: boolean;
  storagePath: string;
  uploadedBy: bigint;
  createdAt: Date;
  uploader?: { username: string; fullname: string } | null;
};

function isAdminUser(user: UserIdentity): boolean {
  return String(user.role || '').toUpperCase().includes('ADMIN');
}

function canReadBook(book: { isPremiumOnly: boolean; uploadedBy: bigint }, user: UserIdentity): boolean {
  if (!book.isPremiumOnly) return true;
  if (Number(book.uploadedBy) === user.id) return true;
  if (isAdminUser(user)) return true;
  return hasActivePremium(user);
}

async function serializeBook(book: BookWithUploader, user: UserIdentity) {
  const isMine = Number(book.uploadedBy) === user.id;
  const coverUrl = book.coverStoragePath ? await createDownloadSignedUrl(book.coverStoragePath).catch(() => null) : null;

  return {
    id: Number(book.id),
    title: book.title,
    description: book.description,
    fileName: book.fileName,
    fileSize: book.fileSize,
    pageCount: book.pageCount,
    isPremiumOnly: book.isPremiumOnly,
    pagesCached: book.pagesCached,
    coverUrl,
    createdAt: book.createdAt,
    uploadedBy: Number(book.uploadedBy),
    uploaderName: book.uploader?.fullname || book.uploader?.username || 'Ẩn danh',
    isMine,
    isLocked: !canReadBook(book, user),
  };
}

export function createBookRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(48, Math.max(1, Number(req.query.pageSize) || 12));
    const search = String(req.query.search || '').trim();

    const where = search ? { title: { contains: search, mode: 'insensitive' as const } } : {};

    const [items, total] = await Promise.all([
      prisma.book.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { uploader: { select: { username: true, fullname: true } } },
      }),
      prisma.book.count({ where }),
    ]);

    res.json({
      success: true,
      items: await Promise.all(items.map((item) => serializeBook(item, user))),
      total,
      page,
      pageSize,
    });
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const id = BigInt(req.params.id);
    const book = await prisma.book.findUnique({
      where: { id },
      include: { uploader: { select: { username: true, fullname: true } } },
    });

    if (!book) {
      res.status(404).json({ success: false, message: 'Không tìm thấy sách.' });
      return;
    }

    const serialized = await serializeBook(book, user);
    if (serialized.isLocked) {
      res.json({ success: true, book: serialized, fileUrl: null, pageUrls: null });
      return;
    }

    const fileUrl = await createDownloadSignedUrl(book.storagePath);

    let pageUrls: string[] | null = null;
    if (book.pagesCached && book.pageCount) {
      pageUrls = await Promise.all(
        Array.from({ length: book.pageCount }, (_, i) => createDownloadSignedUrl(pageStorageKeyFor(book.storagePath, i + 1))),
      );
    }

    res.json({ success: true, book: serialized, fileUrl, pageUrls });
  });

  router.post('/presign', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const fileName = String(req.body.fileName || '').trim();
    const fileSize = Number(req.body.fileSize);

    if (!fileName.toLowerCase().endsWith('.pdf')) {
      res.status(400).json({ success: false, message: 'Chỉ chấp nhận file PDF.' });
      return;
    }
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      res.status(400).json({ success: false, message: 'Dung lượng file không hợp lệ.' });
      return;
    }
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      res.status(413).json({ success: false, message: 'File PDF vượt quá dung lượng cho phép (tối đa 150MB).' });
      return;
    }

    const storagePath = buildBookStoragePath(user.id, fileName);
    const coverStoragePath = coverStorageKeyFor(storagePath);

    const [pdfUploadUrl, coverUploadUrl] = await Promise.all([
      createUploadSignedUrl(storagePath, 'application/pdf'),
      createUploadSignedUrl(coverStoragePath, 'image/jpeg'),
    ]);

    res.json({ success: true, storagePath, pdfUploadUrl, coverStoragePath, coverUploadUrl });
  });

  router.post('/', async (req: Request, res: Response) => {
    const user = await requireUser(req);

    const storagePath = String(req.body.storagePath || '').trim();
    if (!storagePath || !storagePath.startsWith(`${user.id}/`)) {
      res.status(400).json({ success: false, message: 'Đường dẫn file không hợp lệ.' });
      return;
    }

    const actualSize = await headObjectSize(storagePath);
    if (actualSize === null) {
      res.status(400).json({ success: false, message: 'Không tìm thấy file đã tải lên. Vui lòng thử lại.' });
      return;
    }

    const fileName = String(req.body.fileName || '').trim() || 'book.pdf';
    const title = String(req.body.title || '').trim() || fileName.replace(/\.pdf$/i, '');
    const description = String(req.body.description || '').trim() || null;
    const pageCountRaw = Number(req.body.pageCount);
    const pageCount = Number.isFinite(pageCountRaw) && pageCountRaw > 0 ? Math.trunc(pageCountRaw) : null;
    const requestedPremiumOnly = req.body.isPremiumOnly === true || req.body.isPremiumOnly === 'true';
    const isPremiumOnly = requestedPremiumOnly && isAdminUser(user);

    const requestedCoverStoragePath = String(req.body.coverStoragePath || '').trim();
    let coverStoragePath: string | null = null;
    if (requestedCoverStoragePath && requestedCoverStoragePath.startsWith(`${user.id}/`)) {
      const coverSize = await headObjectSize(requestedCoverStoragePath);
      if (coverSize !== null) coverStoragePath = requestedCoverStoragePath;
    }

    const book = await prisma.book.create({
      data: {
        title,
        description,
        storagePath,
        coverStoragePath,
        fileName,
        fileSize: actualSize,
        pageCount,
        isPremiumOnly,
        uploadedBy: BigInt(user.id),
      },
      include: { uploader: { select: { username: true, fullname: true } } },
    });

    res.status(201).json({ success: true, book: await serializeBook(book, user) });
  });

  router.post('/:id/pages/presign', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const id = BigInt(req.params.id);
    const book = await prisma.book.findUnique({ where: { id } });

    if (!book) {
      res.status(404).json({ success: false, message: 'Không tìm thấy sách.' });
      return;
    }
    if (!canReadBook(book, user)) {
      res.status(403).json({ success: false, message: 'Bạn không có quyền truy cập sách này.' });
      return;
    }

    const pageCount = Number(req.body.pageCount);
    if (!Number.isFinite(pageCount) || pageCount <= 0 || pageCount > MAX_PAGE_COUNT) {
      res.status(400).json({ success: false, message: 'Số trang không hợp lệ.' });
      return;
    }

    const uploadUrls = await Promise.all(
      Array.from({ length: pageCount }, async (_, i) => ({
        pageNum: i + 1,
        url: await createUploadSignedUrl(pageStorageKeyFor(book.storagePath, i + 1), 'image/jpeg'),
      })),
    );

    res.json({ success: true, uploadUrls });
  });

  router.post('/:id/pages/confirm', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const id = BigInt(req.params.id);
    const book = await prisma.book.findUnique({ where: { id } });

    if (!book) {
      res.status(404).json({ success: false, message: 'Không tìm thấy sách.' });
      return;
    }
    if (!canReadBook(book, user)) {
      res.status(403).json({ success: false, message: 'Bạn không có quyền truy cập sách này.' });
      return;
    }

    const pageCountRaw = Number(req.body.pageCount);
    const pageCount = Number.isFinite(pageCountRaw) && pageCountRaw > 0 ? Math.trunc(pageCountRaw) : null;

    await prisma.book.update({
      where: { id },
      data: {
        pagesCached: true,
        ...(pageCount && !book.pageCount ? { pageCount } : {}),
      },
    });

    res.json({ success: true });
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const id = BigInt(req.params.id);
    const book = await prisma.book.findUnique({ where: { id } });

    if (!book) {
      res.status(404).json({ success: false, message: 'Không tìm thấy sách.' });
      return;
    }

    const isOwner = Number(book.uploadedBy) === user.id;
    if (!isOwner && !isAdminUser(user)) {
      res.status(403).json({ success: false, message: 'Bạn không có quyền xoá sách này.' });
      return;
    }

    const keysToDelete = [book.storagePath];
    if (book.coverStoragePath) keysToDelete.push(book.coverStoragePath);
    if (book.pagesCached && book.pageCount) {
      for (let i = 1; i <= book.pageCount; i += 1) {
        keysToDelete.push(pageStorageKeyFor(book.storagePath, i));
      }
    }
    await deleteStorageObjects(keysToDelete);
    await prisma.book.delete({ where: { id } });
    res.json({ success: true });
  });

  return router;
}
