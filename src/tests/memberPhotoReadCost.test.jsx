/**
 * WHAT AN AVATAR COSTS — read budget for a members page
 *
 * Firestore bills one document read per document fetched, so the only way to make
 * a list cheaper is to fetch FEWER documents. This file mounts a real 20-row list
 * (real MemberPhoto, real usePhotoStore, real services/photoStore) against a
 * mocked Firestore client and counts `getDoc` calls, which is exactly the number
 * of billed server reads.
 *
 * The contract it pins:
 *
 *   20 rows, no member has a photo      → 0 reads   (was 20)
 *   20 rows, 6 members have a photo     → 6 reads   (was 20)
 *   20 rows, everybody has a photo      → 20 reads  (the flag saves nothing here)
 *   a re-render of the same rows        → 0 more    (the effect is keyed by id)
 *   a fresh mount of the same rows      → reads again (no cache layer, by design)
 *
 * If someone drops the `hasPhoto` gate, the first two numbers go back to 20 and
 * this test fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemberPhoto } from '@/components/common/MemberPhoto'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getDoc: vi.fn(),
    doc: vi.fn((_db, ...path) => ({ path: path.join('/') })),
  },
}))

vi.mock('firebase/firestore', () => ({
  doc: mocks.doc,
  getDoc: mocks.getDoc,
  setDoc: vi.fn(),
  writeBatch: vi.fn(),
  serverTimestamp: vi.fn(() => 'SERVER_TS'),
}))

vi.mock('@/firebase', () => ({ db: { fake: true }, isFirebaseConfigured: true }))

vi.mock('@/utils/image', () => ({ MAX_STORED_BYTES: 300 * 1024, makeThumbnail: vi.fn() }))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ gymId: 'gym-alpha' }) }))

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
}))

const PHOTO = 'data:image/webp;base64,' + 'A'.repeat(64)
const photoSnapshot = { exists: () => true, data: () => ({ data: PHOTO }) }

/** A page of members, `withPhoto` of them flagged as having an avatar. */
const page = (withPhoto) =>
  Array.from({ length: 20 }, (_, index) => ({
    id: `member-${index}`,
    name: `Member ${index}`,
    ...(index < withPhoto ? { hasPhoto: true } : {}),
  }))

const list = (members) => (
  <div>
    {members.map((member) => (
      <MemberPhoto key={member.id} member={member} size="sm" />
    ))}
  </div>
)

describe('member photo read cost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDoc.mockResolvedValue(photoSnapshot)
  })

  it('costs no read at all for a page where nobody has a photo', async () => {
    const { container } = render(list(page(0)))

    await waitFor(() => expect(container.querySelectorAll('div.relative')).toHaveLength(20))
    expect(mocks.getDoc).not.toHaveBeenCalled()
  })

  it('reads once per member that has a photo, not once per row', async () => {
    const { container } = render(list(page(6)))

    await waitFor(() => expect(mocks.getDoc).toHaveBeenCalledTimes(6))
    // The bytes arrive asynchronously, so the rendered avatars are waited for too
    // rather than asserted on the same tick as the read count.
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(6))
  })

  // Stated plainly: the flag is the only saving. A gym where every member has a
  // photo pays exactly what it paid before.
  it('saves nothing when every member has a photo', async () => {
    render(list(page(20)))

    await waitFor(() => expect(mocks.getDoc).toHaveBeenCalledTimes(20))
  })

  it('does not re-read on a re-render but does read again on a fresh mount', async () => {
    const { rerender, unmount } = render(list(page(6)))
    await waitFor(() => expect(mocks.getDoc).toHaveBeenCalledTimes(6))

    // Same components, same rows: the effect does not re-run.
    rerender(list(page(6)))
    expect(mocks.getDoc).toHaveBeenCalledTimes(6)

    // No cache layer: a new mount is a new server read, which is what keeps a
    // photo changed on another device from staying stale here.
    unmount()
    render(list(page(6)))
    await waitFor(() => expect(mocks.getDoc).toHaveBeenCalledTimes(12))
  })
})
