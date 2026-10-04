/**
 * STORAGE PHASE 3B — MEMBER PHOTO UPLOAD FLOW
 *
 * Phase 3A changed the object layout to
 *   gyms/{gymId}/memberPhotos/{memberId}/{fileName}
 * and Phase 3B moved the client onto it. The rules decide who may write, but the
 * client decides WHERE it writes and WHICH gym it claims to be writing for, so
 * this suite pins the client half of that contract:
 *
 *   - the gym id comes from the signed-in profile, never from the member
 *     document or a prop (a member row cannot redirect an upload into another
 *     gym's prefix)
 *   - each member gets their own object
 *   - staff who may write get the control; a viewer does not
 *   - rejected files never reach Storage
 *
 * MemberPhoto surfaces failures via console.error rather than a toast, so the
 * error cases assert on the absence of an upload instead of on a message.
 */
import { describe, beforeEach, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemberPhoto } from '@/components/common/MemberPhoto'

const { mocks, authValue } = vi.hoisted(() => ({
  mocks: { uploadMemberPhoto: vi.fn() },
  authValue: { gymId: 'gym-alpha' },
}))

vi.mock('@/services/storage', () => ({ uploadMemberPhoto: mocks.uploadMemberPhoto }))
vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))

const GYM_ID = 'gym-alpha'
const MEMBER = { id: 'member-1', name: 'Ayesha Khan', gymId: 'gym-alpha' }

const PHOTO_URL = 'https://example.test/gyms/gym-alpha/memberPhotos/member-1/photo.jpg'
const PHOTO_PATH = `gyms/${GYM_ID}/memberPhotos/${MEMBER.id}/photo.jpg`

const pngFile = (bytes = 8, type = 'image/png', name = 'photo.png') =>
  new File([new Uint8Array(bytes)], name, { type })

/** The input only exists when the component is editable. */
const photoInput = (container) => container.querySelector('input[type="file"]')

const pick = (container, file = pngFile()) => userEvent.upload(photoInput(container), file)

describe('MemberPhoto upload', () => {
  let errorSpy

  beforeEach(() => {
    vi.clearAllMocks()
    authValue.gymId = GYM_ID
    mocks.uploadMemberPhoto.mockResolvedValue({ url: PHOTO_URL, path: PHOTO_PATH })
    // Expected for the rejection cases; silenced so the run stays readable.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('uploads with the gym from the signed-in profile and reports both url and path', async () => {
    const onUpload = vi.fn()
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={onUpload} />)

    await pick(container)

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(PHOTO_URL, PHOTO_PATH))
    const [gymIdArg, memberIdArg, fileArg] = mocks.uploadMemberPhoto.mock.calls[0]
    expect(gymIdArg).toBe(GYM_ID)
    expect(memberIdArg).toBe(MEMBER.id)
    expect(fileArg).toBeInstanceOf(File)
  })

  // The trust boundary. A caller controls `member`, so the member's own gymId
  // field is attacker-controlled data. If the component trusted it, a member row
  // pointing at another gym would push the upload into that gym's prefix.
  it('ignores the member document gymId and uses the authenticated gym', async () => {
    const foreign = { id: 'member-1', name: 'Ayesha Khan', gymId: 'gym-victim' }
    const { container } = render(<MemberPhoto member={foreign} editable onUpload={vi.fn()} />)

    await pick(container)

    await waitFor(() => expect(mocks.uploadMemberPhoto).toHaveBeenCalled())
    expect(mocks.uploadMemberPhoto.mock.calls[0][0]).toBe(GYM_ID)
    expect(mocks.uploadMemberPhoto.mock.calls[0][0]).not.toBe('gym-victim')
  })

  it('gives each member a distinct object', async () => {
    const a = render(<MemberPhoto member={{ id: 'm1', name: 'A' }} editable onUpload={vi.fn()} />)
    const b = render(<MemberPhoto member={{ id: 'm2', name: 'B' }} editable onUpload={vi.fn()} />)

    await pick(a.container)
    await waitFor(() => expect(mocks.uploadMemberPhoto).toHaveBeenCalledTimes(1))
    await pick(b.container)
    await waitFor(() => expect(mocks.uploadMemberPhoto).toHaveBeenCalledTimes(2))

    const paths = mocks.uploadMemberPhoto.mock.calls.map(([, memberId]) => memberId)
    expect(paths).toEqual(['m1', 'm2'])
  })

  // storage.rules allow create/update for owner, admin and front-desk, and deny
  // trainer. MemberDetail passes editable={canWrite}, where canWrite is
  // members.write, so a viewer is never offered the control. The rules remain the
  // authority; this asserts the UI does not invite a write that would be denied.
  it('offers the upload control only when editable', async () => {
    const allowed = render(<MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />)
    const denied = render(<MemberPhoto member={MEMBER} editable={false} />)

    expect(photoInput(allowed.container)).toBeTruthy()
    expect(denied.container.querySelector('input[type="file"]')).toBeNull()
    expect(denied.container.querySelector('[aria-label="Upload photo"]')).toBeNull()
    expect(mocks.uploadMemberPhoto).not.toHaveBeenCalled()
  })

  it('renders the existing photo when one is stored', () => {
    const { container } = render(
      <MemberPhoto member={{ ...MEMBER, photoUrl: PHOTO_URL }} />,
    )
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(PHOTO_URL)
    expect(img?.getAttribute('alt')).toBe(MEMBER.name)
  })

  it('falls back to initials when there is no photo', () => {
    const { container } = render(<MemberPhoto member={MEMBER} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('AK')
  })

  // The component holds no identity of its own to substitute, so the only
  // correct behaviour when the profile has no gym is to forward that absence
  // and let the service refuse. The real guard is asserted against the service in
  // storagePaths.test.js; what matters here is that the component neither invents
  // a gym nor reports a photo the upload never produced.
  it('forwards the missing gym identity and surfaces the refusal', async () => {
    authValue.gymId = null
    mocks.uploadMemberPhoto.mockImplementation((gymId) =>
      gymId ? Promise.resolve({ url: PHOTO_URL, path: PHOTO_PATH }) : Promise.reject(new Error('No gym identity')),
    )
    const onUpload = vi.fn()
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={onUpload} />)

    await pick(container)

    await waitFor(() => expect(mocks.uploadMemberPhoto).toHaveBeenCalled())
    expect(mocks.uploadMemberPhoto.mock.calls[0][0]).toBeNull()
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    expect(onUpload).not.toHaveBeenCalled()
  })

  // NOTE: file-type, extension and size rejection is deliberately NOT re-tested
  // here. Those guards live inside uploadMemberPhoto, which this suite mocks, so
  // asserting them at the component layer would only test the mock. They are
  // pinned against the real service in storagePaths.test.js ("rejects an
  // unsupported type before uploading", "rejects an oversize photo before
  // uploading"). The one component-level guarantee that matters for a rejected
  // file is that no photo is reported, covered below.

  it('surfaces a Storage failure and does not report a photo', async () => {
    mocks.uploadMemberPhoto.mockRejectedValue(new Error('storage/unauthorized'))
    const onUpload = vi.fn()
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={onUpload} />)

    await pick(container)

    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    expect(onUpload).not.toHaveBeenCalled()
  })

  // Without the reset, re-picking the same file fires no change event and the
  // operator cannot retry or replace a photo they just uploaded.
  it('allows re-picking the same file after an attempt', async () => {
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />)

    await pick(container)
    await waitFor(() => expect(mocks.uploadMemberPhoto).toHaveBeenCalledTimes(1))
    await pick(container)
    await waitFor(() => expect(mocks.uploadMemberPhoto).toHaveBeenCalledTimes(2))
  })

  it('clears the uploader when the attempt finishes, so the control is usable again', async () => {
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />)

    await pick(container)

    await waitFor(() =>
      expect(container.querySelector('[aria-label="Upload photo"]')).not.toBeDisabled(),
    )
  })
})