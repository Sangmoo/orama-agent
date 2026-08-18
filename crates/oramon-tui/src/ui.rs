//! W1 스켈레톤 UI: 헤더 + 세션 테이블 + 푸터. 탭·필터·액션은 이후 위크에 확장.

use anyhow::Result;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use oramon_collector::Snapshots;
use oramon_core::Config;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table},
    Terminal,
};
use std::{io, sync::Arc, time::Duration};

pub async fn run(cfg: Arc<Config>, mut snap: Snapshots) -> Result<()> {
    // ---- 터미널 진입 ----
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut term = Terminal::new(backend)?;

    let res = event_loop(&mut term, cfg, &mut snap).await;

    // ---- 터미널 복구 (에러 발생해도) ----
    disable_raw_mode()?;
    execute!(term.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    term.show_cursor()?;

    res
}

async fn event_loop<B: ratatui::backend::Backend>(
    term: &mut Terminal<B>,
    cfg: Arc<Config>,
    snap: &mut Snapshots,
) -> Result<()> {
    let mut tick = tokio::time::interval(Duration::from_millis(200));

    loop {
        // 그림
        term.draw(|f| draw(f, &cfg, snap))?;

        // 이벤트 or 틱
        tokio::select! {
            _ = tick.tick() => {}
            _ = snap.sessions.changed() => {}
            _ = snap.banner.changed() => {}
            _ = snap.error.changed() => {}
        }

        // 키 이벤트 (블로킹 없이 폴링)
        if event::poll(Duration::from_millis(0))? {
            if let Event::Key(k) = event::read()? {
                if k.kind == KeyEventKind::Press {
                    match k.code {
                        KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                        _ => {}
                    }
                }
            }
        }
    }
}

fn draw(f: &mut ratatui::Frame, cfg: &Config, snap: &Snapshots) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),   // 헤더
            Constraint::Min(5),      // 세션 테이블
            Constraint::Length(3),   // 푸터 / 에러
        ])
        .split(f.area());

    // ---- 헤더 ----
    let header_text = if let Some(b) = snap.banner.borrow().as_ref() {
        format!(
            " oramon │ {} │ {}@{} │ {} {} │ role={} │ {}",
            cfg.oramon_profile,
            b.instance_name, b.host_name,
            b.version, b.edition, b.database_role,
            chrono::Local::now().format("%H:%M:%S"),
        )
    } else {
        format!(" oramon │ {} │ 연결 중…", cfg.oramon_profile)
    };
    f.render_widget(
        Paragraph::new(header_text)
            .style(Style::default().fg(Color::White).bg(Color::Blue))
            .block(Block::default().borders(Borders::ALL)),
        chunks[0],
    );

    // ---- 세션 테이블 ----
    let rows_data = snap.sessions.borrow().clone();
    let header = Row::new(vec!["SID", "USER", "STATUS", "WAIT_EVENT", "SQL_ID", "MODULE", "BLK"])
        .style(Style::default().add_modifier(Modifier::BOLD));

    let rows: Vec<Row> = rows_data.iter().map(|s| {
        let status_style = match s.status.as_str() {
            "ACTIVE" => Style::default().fg(Color::Green),
            "KILLED" => Style::default().fg(Color::Red),
            _        => Style::default().fg(Color::DarkGray),
        };
        Row::new(vec![
            Cell::from(format!("{}.{}", s.inst_id, s.sid)),
            Cell::from(s.username.clone().unwrap_or_default()),
            Cell::from(s.status.clone()).style(status_style),
            Cell::from(s.event.clone().unwrap_or_default()),
            Cell::from(s.sql_id.clone().unwrap_or_default()),
            Cell::from(s.module.clone().unwrap_or_default()),
            Cell::from(s.blocking_session.map(|x| x.to_string()).unwrap_or_default()),
        ])
    }).collect();

    let widths = [
        Constraint::Length(8),
        Constraint::Length(14),
        Constraint::Length(10),
        Constraint::Length(30),
        Constraint::Length(14),
        Constraint::Length(20),
        Constraint::Length(6),
    ];

    f.render_widget(
        Table::new(rows, widths)
            .header(header)
            .block(Block::default()
                .borders(Borders::ALL)
                .title(format!(" Sessions ({}) ", rows_data.len()))),
        chunks[1],
    );

    // ---- 푸터 (에러 또는 도움말) ----
    let footer: Line = if let Some(err) = snap.error.borrow().as_ref() {
        Line::from(vec![
            Span::styled(" ERROR: ", Style::default().fg(Color::White).bg(Color::Red)),
            Span::raw(" "),
            Span::styled(err.clone(), Style::default().fg(Color::Red)),
        ])
    } else {
        Line::from(" q quit │ (다음 위크: / filter · K kill · X explain · T tune) ")
    };
    f.render_widget(
        Paragraph::new(footer).block(Block::default().borders(Borders::ALL)),
        chunks[2],
    );
}
