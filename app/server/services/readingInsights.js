const fs = require('fs');
const path = require('path');
const { dbGet, dbAll } = require('../db');
const { getMissingMetadataFields } = require('./bookMetadataAi');

function getRole(user) {
    return user?.role || 'user';
}

function getPeriodRange(period = 'month') {
    const now = new Date();
    const current = new Date(now);
    current.setHours(0, 0, 0, 0);

    switch (period) {
        case 'week': {
            const day = current.getDay();
            const diff = day === 0 ? 6 : day - 1;
            current.setDate(current.getDate() - diff);
            return { period: 'week', label: '本周', startMs: current.getTime() };
        }
        case 'year':
            current.setMonth(0, 1);
            return { period: 'year', label: '今年', startMs: current.getTime() };
        case 'all':
            return { period: 'all', label: '总计', startMs: null };
        case 'month':
        default:
            current.setDate(1);
            return { period: 'month', label: '本月', startMs: current.getTime() };
    }
}

function formatDuration(totalSeconds = 0) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const hours = Math.floor(minutes / 60);

    return {
        seconds: safeSeconds,
        minutes,
        hours,
        formatted: hours > 0
            ? `${hours}小时${minutes % 60}分钟`
            : `${minutes}分钟`
    };
}

function formatFileSize(size = 0) {
    const safeSize = Math.max(0, Number(size) || 0);
    if (safeSize < 1024) return `${safeSize} B`;

    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = safeSize / 1024;
    let index = 0;

    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }

    return `${value.toFixed(value >= 10 || index === 0 ? 1 : 2)} ${units[index]}`;
}

function getAccessJoinSql() {
    return `
        LEFT JOIN libraries l ON b.library_id = l.id
        LEFT JOIN user_library_permissions ulp ON l.id = ulp.library_id AND ulp.user_id = ?
    `;
}

function getAccessWhereSql() {
    return `
        (
            b.owner_id = ?
            OR b.is_public = 1
            OR (l.is_public = 1 AND (ulp.library_id IS NOT NULL OR ? = 'admin'))
        )
    `;
}

function getAccessJoinParams(user) {
    return [user.id];
}

function getAccessWhereParams(user) {
    return [user.id, getRole(user)];
}

function mapProgressRow(row) {
    return {
        book_id: row.book_id,
        title: row.title,
        author: row.author || null,
        publisher: row.publisher || null,
        format: row.format,
        cover: row.cover || null,
        library_name: row.library_name || null,
        in_bookshelf: row.in_bookshelf === 1,
        progress_percent: Number(row.progress_percent || 0),
        chapter_percent: Number(row.chapter_percent || 0),
        chapter_index: row.chapter_index || 0,
        chapter_title: row.chapter_title || null,
        anchor_text: row.anchor_text || null,
        last_read: row.last_read || null,
        device_id: row.device_id || null,
        status: Number(row.progress_percent || 0) >= 95 ? 'finished' : 'reading'
    };
}

async function getBookDetail(user, bookId) {
    const sql = `
        SELECT
            b.*,
            l.name AS library_name,
            l.path AS library_path,
            l.is_public AS lib_is_public,
            CASE WHEN bs.book_id IS NOT NULL THEN 1 ELSE 0 END AS in_bookshelf,
            p.progress_percent,
            p.chapter_percent,
            p.chapter_index,
            p.chapter_title,
            p.anchor_text,
            p.last_read
        FROM books b
        ${getAccessJoinSql()}
        LEFT JOIN bookshelf bs ON bs.book_id = b.id AND bs.user_id = ?
        LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?
        WHERE b.id = ?
          AND ${getAccessWhereSql()}
        LIMIT 1
    `;

    const row = await dbGet(sql, [
        ...getAccessJoinParams(user),
        user.id,
        user.id,
        bookId,
        ...getAccessWhereParams(user)
    ]);

    if (!row) {
        return null;
    }

    const [reading, notes, bookmarks] = await Promise.all([
        dbGet(
            "SELECT COALESCE(SUM(duration_seconds), 0) AS total_seconds FROM reading_stats WHERE user_id = ? AND book_id = ?",
            [user.id, bookId]
        ),
        dbGet("SELECT COUNT(*) AS count FROM notes WHERE user_id = ? AND book_id = ?", [user.id, bookId]),
        dbGet("SELECT COUNT(*) AS count FROM bookmarks WHERE user_id = ? AND book_id = ?", [user.id, bookId])
    ]);

    return {
        id: row.id,
        title: row.title,
        author: row.author || null,
        publisher: row.publisher || null,
        format: row.format,
        cover: row.cover || null,
        filepath: row.filepath,
        library_id: row.library_id || null,
        library_name: row.library_name || null,
        owner_id: row.owner_id,
        is_public: row.is_public === 1,
        in_bookshelf: row.in_bookshelf === 1,
        created_at: row.created_at || null,
        size_bytes: Number(row.size || 0),
        size_human: formatFileSize(row.size),
        file_exists: !!(row.filepath && fs.existsSync(row.filepath)),
        metadata: {
            description: row.description || null,
            isbn: row.isbn || null,
            published_year: row.published_year || null,
            page_count: null,
            word_count: null
        },
        missing_metadata_fields: getMissingMetadataFields({
            author: row.author,
            publisher: row.publisher,
            description: row.description,
            published_year: row.published_year,
            isbn: row.isbn
        }),
        reading: {
            total_time: formatDuration(reading?.total_seconds || 0),
            notes_count: notes?.count || 0,
            bookmarks_count: bookmarks?.count || 0,
            progress: {
                progress_percent: Number(row.progress_percent || 0),
                chapter_percent: Number(row.chapter_percent || 0),
                chapter_index: row.chapter_index || 0,
                chapter_title: row.chapter_title || null,
                anchor_text: row.anchor_text || null,
                last_read: row.last_read || null
            }
        }
    };
}

async function getReadingProgress(user, options = {}) {
    const { bookId = null, limit = 100 } = options;
    const params = [
        ...getAccessJoinParams(user),
        user.id,
        user.id
    ];
    let sql = `
        SELECT
            p.book_id,
            b.title,
            b.author,
            b.publisher,
            b.format,
            b.cover,
            l.name AS library_name,
            CASE WHEN bs.book_id IS NOT NULL THEN 1 ELSE 0 END AS in_bookshelf,
            p.progress_percent,
            p.chapter_percent,
            p.chapter_index,
            p.chapter_title,
            p.anchor_text,
            p.last_read,
            p.device_id
        FROM progress p
        JOIN books b ON b.id = p.book_id
        ${getAccessJoinSql()}
        LEFT JOIN bookshelf bs ON bs.book_id = b.id AND bs.user_id = ?
        WHERE p.user_id = ?
          AND ${getAccessWhereSql()}
    `;

    params.push(...getAccessWhereParams(user));

    if (bookId) {
        sql += ` AND p.book_id = ?`;
        params.push(bookId);
    }

    sql += ` ORDER BY p.last_read DESC LIMIT ?`;
    params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200));

    const rows = await dbAll(sql, params);
    const items = rows.map(mapProgressRow);

    return {
        total: items.length,
        items
    };
}

async function getReadingStats(user, period = 'month') {
    const periodInfo = getPeriodRange(period);
    const filterSql = periodInfo.startMs === null ? '' : 'AND rs.date >= ?';
    const filterParams = periodInfo.startMs === null ? [] : [periodInfo.startMs];

    // Summary keeps historical reading assets even if books were later moved, deleted,
    // or became inaccessible. Lists below still apply current access filtering.
    const summarySql = `
        SELECT
            COALESCE(SUM(rs.duration_seconds), 0) AS total_reading_seconds,
            COUNT(DISTINCT DATE(rs.date / 1000, 'unixepoch', 'localtime')) AS reading_days,
            COUNT(DISTINCT rs.book_id) AS books_started,
            COUNT(DISTINCT CASE WHEN COALESCE(p.progress_percent, 0) >= 95 THEN rs.book_id END) AS books_finished
        FROM reading_stats rs
        LEFT JOIN progress p ON p.book_id = rs.book_id AND p.user_id = rs.user_id
        WHERE rs.user_id = ?
          ${filterSql}
    `;

    const summary = await dbGet(summarySql, [
        user.id,
        ...filterParams
    ]);

    const topBooksSql = `
        SELECT
            b.id,
            b.title,
            b.author,
            b.publisher,
            b.format,
            b.cover,
            COALESCE(p.progress_percent, 0) AS progress_percent,
            COALESCE(SUM(rs.duration_seconds), 0) AS total_reading_seconds,
            MAX(rs.date) AS last_read
        FROM reading_stats rs
        JOIN books b ON b.id = rs.book_id
        ${getAccessJoinSql()}
        LEFT JOIN progress p ON p.book_id = rs.book_id AND p.user_id = rs.user_id
        WHERE rs.user_id = ?
          AND ${getAccessWhereSql()}
          ${filterSql}
        GROUP BY b.id
        ORDER BY total_reading_seconds DESC, last_read DESC
        LIMIT 10
    `;

    const topAuthorsSql = `
        SELECT
            COALESCE(NULLIF(TRIM(b.author), ''), '未知作者') AS author,
            COALESCE(SUM(rs.duration_seconds), 0) AS total_reading_seconds
        FROM reading_stats rs
        JOIN books b ON b.id = rs.book_id
        ${getAccessJoinSql()}
        WHERE rs.user_id = ?
          AND ${getAccessWhereSql()}
          ${filterSql}
        GROUP BY author
        ORDER BY total_reading_seconds DESC, author ASC
        LIMIT 5
    `;

    const topPublishersSql = `
        SELECT
            COALESCE(NULLIF(TRIM(b.publisher), ''), '未知出版社') AS publisher,
            COALESCE(SUM(rs.duration_seconds), 0) AS total_reading_seconds
        FROM reading_stats rs
        JOIN books b ON b.id = rs.book_id
        ${getAccessJoinSql()}
        WHERE rs.user_id = ?
          AND ${getAccessWhereSql()}
          ${filterSql}
        GROUP BY publisher
        ORDER BY total_reading_seconds DESC, publisher ASC
        LIMIT 5
    `;

    const formatDistributionSql = `
        SELECT
            UPPER(COALESCE(NULLIF(TRIM(b.format), ''), 'UNKNOWN')) AS format,
            COALESCE(SUM(rs.duration_seconds), 0) AS total_reading_seconds
        FROM reading_stats rs
        JOIN books b ON b.id = rs.book_id
        ${getAccessJoinSql()}
        WHERE rs.user_id = ?
          AND ${getAccessWhereSql()}
          ${filterSql}
        GROUP BY format
        ORDER BY total_reading_seconds DESC, format ASC
    `;

    const hourlyDistributionSql = `
        SELECT
            CAST(strftime('%H', rs.date / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
            COALESCE(SUM(rs.duration_seconds), 0) AS total_reading_seconds
        FROM reading_stats rs
        JOIN books b ON b.id = rs.book_id
        ${getAccessJoinSql()}
        WHERE rs.user_id = ?
          AND ${getAccessWhereSql()}
          ${filterSql}
        GROUP BY hour
        ORDER BY hour ASC
    `;

    const queryParams = [
        ...getAccessJoinParams(user),
        user.id,
        ...getAccessWhereParams(user),
        ...filterParams
    ];

    const [topBooks, topAuthors, topPublishers, formatDistribution, hourlyDistribution] = await Promise.all([
        dbAll(topBooksSql, queryParams),
        dbAll(topAuthorsSql, queryParams),
        dbAll(topPublishersSql, queryParams),
        dbAll(formatDistributionSql, queryParams),
        dbAll(hourlyDistributionSql, queryParams)
    ]);

    const notesCount = await dbGet(
        `SELECT COUNT(*) AS count FROM notes WHERE user_id = ? ${periodInfo.startMs === null ? '' : `AND datetime(created_at, 'localtime') >= datetime(? / 1000, 'unixepoch', 'localtime')`}`,
        periodInfo.startMs === null ? [user.id] : [user.id, periodInfo.startMs]
    );

    const readingByHour = Array.from({ length: 24 }, (_, hour) => {
        const match = hourlyDistribution.find(item => item.hour === hour);
        return {
            hour,
            total_reading_seconds: match?.total_reading_seconds || 0
        };
    });

    return {
        period: periodInfo.period,
        period_label: periodInfo.label,
        range_start: periodInfo.startMs,
        summary: {
            books_started: summary?.books_started || 0,
            books_finished: summary?.books_finished || 0,
            reading_days: summary?.reading_days || 0,
            notes_count: notesCount?.count || 0,
            total_reading_time: formatDuration(summary?.total_reading_seconds || 0)
        },
        top_books: topBooks.map(item => ({
            id: item.id,
            title: item.title,
            author: item.author || null,
            publisher: item.publisher || null,
            format: item.format,
            cover: item.cover || null,
            progress_percent: Number(item.progress_percent || 0),
            last_read: item.last_read || null,
            total_reading_time: formatDuration(item.total_reading_seconds || 0)
        })),
        top_authors: topAuthors.map(item => ({
            author: item.author,
            total_reading_time: formatDuration(item.total_reading_seconds || 0)
        })),
        top_publishers: topPublishers.map(item => ({
            publisher: item.publisher,
            total_reading_time: formatDuration(item.total_reading_seconds || 0)
        })),
        format_distribution: formatDistribution.map(item => ({
            format: item.format,
            total_reading_time: formatDuration(item.total_reading_seconds || 0)
        })),
        reading_by_hour: readingByHour
    };
}

async function getUserReadingProfile(user) {
    const [allStats, monthStats, progress, bookshelfCount, bookmarksCount, notesCount] = await Promise.all([
        getReadingStats(user, 'all'),
        getReadingStats(user, 'month'),
        getReadingProgress(user, { limit: 20 }),
        dbGet("SELECT COUNT(*) AS count FROM bookshelf WHERE user_id = ?", [user.id]),
        dbGet("SELECT COUNT(*) AS count FROM bookmarks WHERE user_id = ?", [user.id]),
        dbGet("SELECT COUNT(*) AS count FROM notes WHERE user_id = ?", [user.id])
    ]);

    const currentlyReading = progress.items
        .filter(item => item.progress_percent > 0 && item.progress_percent < 95)
        .slice(0, 5);

    const recentlyRead = progress.items.slice(0, 10);

    return {
        user_id: user.id,
        overview: {
            bookshelf_count: bookshelfCount?.count || 0,
            bookmarks_count: bookmarksCount?.count || 0,
            notes_count: notesCount?.count || 0,
            books_with_progress: progress.total,
            books_finished: allStats.summary.books_finished,
            currently_reading_count: currentlyReading.length,
            total_reading_time: allStats.summary.total_reading_time
        },
        current_period: {
            period: monthStats.period,
            period_label: monthStats.period_label,
            summary: monthStats.summary
        },
        favorites: {
            authors: allStats.top_authors.slice(0, 3),
            publishers: allStats.top_publishers.slice(0, 3),
            formats: allStats.format_distribution.slice(0, 3)
        },
        currently_reading: currentlyReading,
        recently_read: recentlyRead
    };
}

module.exports = {
    formatDuration,
    getPeriodRange,
    getBookDetail,
    getAccessJoinParams,
    getAccessWhereParams,
    getReadingProgress,
    getReadingStats,
    getUserReadingProfile
};
