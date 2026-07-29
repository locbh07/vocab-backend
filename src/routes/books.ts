import { Request, Response, Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireUser, UserIdentity } from '../middleware/userGuard';
import { hasActivePremium } from '../lib/contentAccess';
import {
  buildBookStoragePath,
  coverStorageKeyFor,
  createCoverSignedUrl,
  createDownloadSignedUrl,
  createUploadSignedUrl,
  deleteStorageObjects,
  headObjectSize,
  pageStorageKeyFor,
} from '../lib/bookStorage';

const MAX_FILE_SIZE_BYTES = 150 * 1024 * 1024;
const MAX_PAGE_COUNT = 2000;
const MAX_BOOKS_PER_USER = 3;

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
  sortOrder: number;
  isHidden: boolean;
  isApproved: boolean;
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

// Upload is open to any logged-in user now (previously premium-only) — non-admin uploads just
// start unapproved (see POST /) and don't appear in the public list until an admin reviews them,
// and are capped at MAX_BOOKS_PER_USER each since storage isn't unlimited.
async function assertCanUploadMoreBooks(user: UserIdentity): Promise<string | null> {
  if (isAdminUser(user)) return null;
  const count = await prisma.book.count({ where: { uploadedBy: BigInt(user.id) } });
  if (count >= MAX_BOOKS_PER_USER) {
    return `Bạn đã đạt giới hạn tối đa ${MAX_BOOKS_PER_USER} quyển sách (do dung lượng lưu trữ có hạn).`;
  }
  return null;
}

async function serializeBook(book: BookWithUploader, user: UserIdentity) {
  const isMine = Number(book.uploadedBy) === user.id;
  const coverUrl = book.coverStoragePath ? await createCoverSignedUrl(book.coverStoragePath).catch(() => null) : null;

  return {
    id: Number(book.id),
    title: book.title,
    description: book.description,
    fileName: book.fileName,
    fileSize: book.fileSize,
    pageCount: book.pageCount,
    isPremiumOnly: book.isPremiumOnly,
    pagesCached: book.pagesCached,
    sortOrder: book.sortOrder,
    isHidden: book.isHidden,
    isApproved: book.isApproved,
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
    const admin = isAdminUser(user);
    // Admin-only escape hatch for the reorder UI, which needs the full list (in sortOrder)
    // to build a draggable list rather than one paginated page at a time.
    const wantsAll = admin && String(req.query.all || '') === 'true';

    const where = {
      ...(search ? { title: { contains: search, mode: 'insensitive' as const } } : {}),
      ...(admin ? {} : { isHidden: false, isApproved: true }),
    };

    const [items, total] = await Promise.all([
      prisma.book.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        ...(wantsAll ? {} : { skip: (page - 1) * pageSize, take: pageSize }),
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

  router.get('/check-filename', async (req: Request, res: Response) => {
    await requireUser(req);
    const fileName = String(req.query.fileName || '').trim();
    if (!fileName) {
      res.json({ success: true, exists: false });
      return;
    }

    const existing = await prisma.book.findFirst({
      where: { fileName: { equals: fileName, mode: 'insensitive' } },
      include: { uploader: { select: { username: true, fullname: true } } },
    });

    if (!existing) {
      res.json({ success: true, exists: false });
      return;
    }

    res.json({
      success: true,
      exists: true,
      book: {
        id: Number(existing.id),
        title: existing.title,
        uploaderName: existing.uploader?.fullname || existing.uploader?.username || 'Ẩn danh',
      },
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

    const isOwner = Number(book.uploadedBy) === user.id;
    if ((book.isHidden || !book.isApproved) && !isOwner && !isAdminUser(user)) {
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

    const capMessage = await assertCanUploadMoreBooks(user);
    if (capMessage) {
      res.status(403).json({ success: false, message: capMessage });
      return;
    }

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

    const existing = await prisma.book.findFirst({
      where: { fileName: { equals: fileName, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      res.status(409).json({ success: false, message: `File "${fileName}" đã có trong thư viện rồi.` });
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

    const capMessage = await assertCanUploadMoreBooks(user);
    if (capMessage) {
      res.status(403).json({ success: false, message: capMessage });
      return;
    }

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

    const existing = await prisma.book.findFirst({
      where: { fileName: { equals: fileName, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      res.status(409).json({ success: false, message: `File "${fileName}" đã có trong thư viện rồi.` });
      return;
    }

    const title = String(req.body.title || '').trim() || fileName.replace(/\.pdf$/i, '');
    const description = String(req.body.description || '').trim() || null;
    const pageCountRaw = Number(req.body.pageCount);
    const pageCount = Number.isFinite(pageCountRaw) && pageCountRaw > 0 ? Math.trunc(pageCountRaw) : null;
    const requestedPremiumOnly = req.body.isPremiumOnly === true || req.body.isPremiumOnly === 'true';
    const isPremiumOnly = requestedPremiumOnly && isAdminUser(user);
    // Admin uploads go live immediately; everyone else's need an admin to review and approve
    // before the book shows up in the public list (see GET / and GET /:id filtering above).
    const isApproved = isAdminUser(user);

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
        isApproved,
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

  // Registered before the /:id param route below so Express doesn't match "reorder" as an id.
  router.patch('/reorder', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    if (!isAdminUser(user)) {
      res.status(403).json({ success: false, message: 'Chỉ admin mới có thể sắp xếp thứ tự sách.' });
      return;
    }

    const order: unknown[] = Array.isArray(req.body.order) ? req.body.order : [];
    const updates: Array<{ id: number; sortOrder: number }> = order
      .map((entry) => {
        const record = entry as { id?: unknown; sortOrder?: unknown };
        return { id: Number(record?.id), sortOrder: Number(record?.sortOrder) };
      })
      .filter((entry) => Number.isFinite(entry.id) && entry.id > 0 && Number.isFinite(entry.sortOrder));

    if (!updates.length) {
      res.status(400).json({ success: false, message: 'Danh sách thứ tự không hợp lệ.' });
      return;
    }

    await prisma.$transaction(
      updates.map((entry) =>
        prisma.book.update({
          where: { id: BigInt(entry.id) },
          data: { sortOrder: Math.trunc(entry.sortOrder) },
        }),
      ),
    );

    res.json({ success: true });
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const id = BigInt(req.params.id);

    if (!isAdminUser(user)) {
      res.status(403).json({ success: false, message: 'Chỉ admin mới có thể chỉnh sửa sách.' });
      return;
    }

    const book = await prisma.book.findUnique({ where: { id } });
    if (!book) {
      res.status(404).json({ success: false, message: 'Không tìm thấy sách.' });
      return;
    }

    const data: {
      title?: string;
      description?: string | null;
      isPremiumOnly?: boolean;
      sortOrder?: number;
      isHidden?: boolean;
      isApproved?: boolean;
    } = {};

    if (req.body.title !== undefined) {
      const title = String(req.body.title || '').trim();
      if (!title) {
        res.status(400).json({ success: false, message: 'Tên sách không được để trống.' });
        return;
      }
      data.title = title;
    }
    if (req.body.description !== undefined) {
      const description = String(req.body.description || '').trim();
      data.description = description || null;
    }
    if (req.body.isPremiumOnly !== undefined) {
      data.isPremiumOnly = req.body.isPremiumOnly === true || req.body.isPremiumOnly === 'true';
    }
    if (req.body.sortOrder !== undefined) {
      const sortOrder = Number(req.body.sortOrder);
      if (!Number.isFinite(sortOrder)) {
        res.status(400).json({ success: false, message: 'Thứ tự hiển thị không hợp lệ.' });
        return;
      }
      data.sortOrder = Math.trunc(sortOrder);
    }
    if (req.body.isHidden !== undefined) {
      data.isHidden = req.body.isHidden === true || req.body.isHidden === 'true';
    }
    if (req.body.isApproved !== undefined) {
      data.isApproved = req.body.isApproved === true || req.body.isApproved === 'true';
    }

    const updated = await prisma.book.update({
      where: { id },
      data,
      include: { uploader: { select: { username: true, fullname: true } } },
    });

    res.json({ success: true, book: await serializeBook(updated, user) });
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
