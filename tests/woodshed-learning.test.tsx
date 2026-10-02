// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WoodshedPage from '../src/renderer/src/pages/WoodshedPage.js'
import { GUITAR_READING, LEARNING_SYSTEMS } from '../src/renderer/src/woodshed/knowledge.js'

vi.mock('../src/renderer/src/woodshed/audio.js', () => ({ WoodshedAudio: class {
  stop() {} destroy() {} setReference() {} async setOutput() {}
} }))
beforeEach(() => { localStorage.clear(); Element.prototype.scrollTo = vi.fn() })
afterEach(cleanup)
describe('learning navigation', () => {
  it('opens systems, roadmap and a pure article, then jumps back through breadcrumbs', () => {
    render(<WoodshedPage onToast={vi.fn()} />)
    for (const system of LEARNING_SYSTEMS) {
      fireEvent.click(screen.getByRole('button', { name: system.title, exact: true }))
      const firstNode = system.stages[0]!.nodes[0]!
      fireEvent.click(screen.getByRole('button', { name: firstNode.title, exact: true }))
      expect(screen.getByRole('article').textContent).toContain(firstNode.example)
      fireEvent.click(within(screen.getByRole('navigation', { name: '页面路径' })).getByRole('button', { name: '练功房', exact: true }))
    }
  })
  it('keeps learning independent of instrument settings and preserves sidebar collapse', () => {
    const first = render(<WoodshedPage onToast={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '吉他', exact: true }))
    expect(screen.getByRole('list', { name: '吉他知识路线图' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '指板音名与音程', exact: true }))
    expect(screen.getByRole('article').textContent).toContain('第六弦第五品')
    expect(screen.queryByLabelText('乐器与调弦')).toBeNull()
    expect(screen.queryByText('练习工作台')).toBeNull()
    expect(screen.queryByText('重置练习参数')).toBeNull()
    expect(screen.queryByText('学习目录')).toBeNull()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('固定标准定弦')
    const path = within(screen.getByRole('navigation', { name: '页面路径' }))
    fireEvent.click(path.getByRole('button', { name: '吉他', exact: true }))
    expect(screen.queryByRole('article')).toBeNull()
    fireEvent.click(path.getByRole('button', { name: '系统学习', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '贝斯', exact: true }))
    expect(screen.getByRole('list', { name: '贝斯知识路线图' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '折叠左侧菜单' }))
    expect(screen.getByRole('button', { name: '展开左侧菜单' }).getAttribute('aria-expanded')).toBe('false')
    first.unmount()
    render(<WoodshedPage onToast={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '展开左侧菜单' }))
    expect(screen.getByRole('button', { name: '折叠左侧菜单' }).getAttribute('aria-expanded')).toBe('true')
  })
  it('has complete unique knowledge nodes and all eight guitar stages', () => {
    const nodes = LEARNING_SYSTEMS.flatMap(s => s.stages.flatMap(g => g.nodes))
    expect(new Set(nodes.map(n => n.id)).size).toBe(nodes.length)
    expect(LEARNING_SYSTEMS.find(s => s.id === 'guitar')!.stages).toHaveLength(8)
    for (const id of Object.values(GUITAR_READING)) expect(nodes.some(n => n.id === id)).toBe(true)
    for (const node of nodes) { expect(node.paragraphs.join('').length).toBeGreaterThan(20); expect(node.example.length).toBeGreaterThan(10) }
  })
  it('shows ensemble stage outcomes and prerequisites and links knowledge to practice and back', () => {
    render(<WoodshedPage onToast={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '鼓', exact: true }))
    expect(screen.getAllByText(/^阶段成果：/).length).toBe(8)
    expect(screen.getByText('先修关系与进入条件')).toBeTruthy()
    const node = LEARNING_SYSTEMS.find(s => s.id === 'drums')!.stages[0]!.nodes[0]!
    fireEvent.click(screen.getByRole('button', { name: node.title, exact: true }))
    const article = screen.getByRole('article')
    expect(within(article).queryByText('练习工作台')).toBeNull()
    const links = within(article).getAllByRole('button')
    expect(links.length).toBeGreaterThan(0)
    fireEvent.click(links[0]!)
    expect(screen.getByText(/建议 S/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `知识：${node.title}`, exact: true }))
    expect(screen.getByRole('heading', { name: node.title, exact: true })).toBeTruthy()
  })
})
