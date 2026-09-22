import type { Lesson } from './types.js'
import { COURSES, chapterFor } from './course-plan.js'
import './course.css'
export function CourseGuide({
  track,
  lessons,
  onSelect
}: {
  track: Lesson['track']
  lessons: readonly Lesson[]
  onSelect: (lesson: Lesson) => void
}): React.JSX.Element {
  const course = COURSES[track]
  return (
    <details className="ws-course-guide" key={track}>
      <summary>
        <span>学习路线导览</span>
        <small>
          {course.chapters.length} 个章节 · {course.chapters.reduce((sum, c) => sum + c.lessonIds.length, 0)}{' '}
          个单元 · 可自由跳转
        </small>
      </summary>
      <p>{course.intro}</p>
      <div className="ws-course-stages">
        {course.chapters.map((chapter, i) => (
          <section key={chapter.id}>
            <span className="ws-eyebrow">
              阶段 {i + 1} · {chapter.lessonIds.length} 单元
            </span>
            <h3>{chapter.title}</h3>
            <p>{chapter.transfer}</p>
            <ol>
              {chapter.lessonIds.map((id) => {
                const lesson = lessons.find((l) => l.id === id)!
                return (
                  <li key={id}>
                    <button onClick={() => onSelect(lesson)}>{lesson.title}</button>
                  </li>
                )
              })}
            </ol>
          </section>
        ))}
      </div>
    </details>
  )
}
export function ChapterDepth({ lesson }: { lesson: Lesson }): React.JSX.Element {
  const chapter = chapterFor(lesson)
  return (
    <details className="ws-chapter-depth" key={chapter.id}>
      <summary>深入本章 · {chapter.title}</summary>
      <h3>把知识连起来</h3>
      <p>{chapter.concept}</p>
      <div className="ws-example">
        <span>展开一个具体例子</span>
        <p>{chapter.example}</p>
      </div>
      <h3>听什么，而不只看什么</h3>
      <p>{chapter.listen}</p>
      <h3>分层练习安排</h3>
      <ol className="ws-steps">
        {chapter.drills.map((step, i) => (
          <li key={i}>
            <span>{i + 1}</span>
            <p>{step}</p>
          </li>
        ))}
      </ol>
      <div className="ws-chapter-diagnosis">
        <h4>卡住时怎么排查</h4>
        <p>{chapter.diagnosis}</p>
      </div>
      <h3>带回音乐里</h3>
      <p>{chapter.transfer}</p>
      <small>按自检情况决定停留或进阶；这些是可反复使用的练习安排，不记录完成率或成绩。</small>
    </details>
  )
}
