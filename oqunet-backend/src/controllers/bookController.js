// src/controllers/bookController.js - WITH FIXED ASSOCIATIONS
const { User, Book, Community } = require('../models');
const db = require('../models');

// Admin: Assign book to user
const assignBook = async (req, res) => {
  const { book_id, user_id } = req.body;
  try {
    const book = await Book.findByPk(book_id);
    const user = await User.findByPk(user_id);

    if (!book) return res.status(404).json({ message: 'Book табылмады' });
    if (!user) return res.status(404).json({ message: 'User табылмады' });

    book.current_holder_id = user.id;
    book.borrowed_at = new Date();
    await book.save();

    res.json({ message: 'Book берілді', book });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Admin: Return book
const returnBook = async (req, res) => {
  const { book_id } = req.body;
  try {
    const book = await Book.findByPk(book_id);
    if (!book) return res.status(404).json({ message: 'Book табылмады' });

    book.current_holder_id = null;
    book.borrowed_at = null;
    await book.save();

    res.json({ message: 'Book қайтарылды', book });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// User: Borrow book (өзі алу)
const borrowBook = async (req, res) => {
  const { book_id } = req.body;
  const userId = req.user.id;

  try {
    const userCurrentBook = await Book.findOne({
      where: { current_holder_id: userId }
    });

    if (userCurrentBook) {
      return res.status(400).json({ 
        message: `Сізде қазір кітап бар: "${userCurrentBook.title}". Алдымен оны қайтарыңыз.`,
        currentBook: userCurrentBook.title
      });
    }

    const book = await Book.findByPk(book_id, {
      include: [
        { 
          model: User, 
          as: 'holder', 
          attributes: ['id', 'name', 'phone'],
          required: false
        },
        { 
          model: User, 
          as: 'initialHolder', 
          attributes: ['id', 'name', 'phone'],
          required: false
        },
        { 
          model: Community, 
          attributes: ['id', 'name'],
          required: false
        }
      ]
    });

    if (!book) {
      return res.status(404).json({ message: 'Кітап табылмады' });
    }

    if (book.current_holder_id) {
      return res.status(400).json({ 
        message: `Кітап басқа адамда: ${book.holder.name}`,
        holder: book.holder.name
      });
    }

    if (req.user.role !== 'admin' && book.community_id !== req.user.community_id) {
      return res.status(403).json({ message: 'Бұл кітап басқа қоғамдастыққа тиесілі' });
    }

    book.current_holder_id = userId;
    book.borrowed_at = new Date();
    await book.save();

    await book.reload({
      include: [
        { 
          model: User, 
          as: 'holder', 
          attributes: ['id', 'name', 'phone'],
          required: false
        },
        { 
          model: User, 
          as: 'initialHolder', 
          attributes: ['id', 'name', 'phone'],
          required: false
        },
        { 
          model: Community, 
          attributes: ['id', 'name'],
          required: false
        }
      ]
    });

    res.json({ 
      message: 'Кітап сізге берілді!', 
      book: book.toJSON()
    });
  } catch (err) {
    console.error('Borrow book error:', err);
    res.status(500).json({ message: err.message });
  }
};

// User: Return book (қайтару)
const returnMyBook = async (req, res) => {
  const { book_id } = req.body;
  const userId = req.user.id;

  try {
    const book = await Book.findByPk(book_id);

    if (!book) {
      return res.status(404).json({ message: 'Кітап табылмады' });
    }

    if (book.current_holder_id !== userId) {
      return res.status(403).json({ message: 'Бұл кітап сізде жоқ' });
    }

    await db.BookHistory.create({
      book_id: book.id,
      user_id: userId,
      borrowed_at: book.borrowed_at,
      returned_at: new Date()
    });

    book.current_holder_id = null;
    book.borrowed_at = null;
    await book.save();

    res.json({ 
      message: 'Кітап қайтарылды', 
      book: book.toJSON()
    });
  } catch (err) {
    console.error('Return book error:', err);
    res.status(500).json({ message: err.message });
  }
};

// Get all books
const getAllBooks = async (req, res) => {
  try {
    const where = {};
    
    if (req.user.role !== 'admin') {
      where.community_id = req.user.community_id;
    }

    const books = await Book.findAll({
      where,
      include: [
        { 
          model: User, 
          as: 'holder', 
          attributes: ['id', 'name', 'email', 'phone'],
          required: false
        },
        { 
          model: User, 
          as: 'initialHolder', 
          attributes: ['id', 'name', 'email', 'phone'],
          required: false
        },
        { 
          model: Community, 
          attributes: ['id', 'name'],
          required: false
        }
      ],
      order: [['id', 'ASC']]
    });
    
    res.json({ books: books.map(b => b.toJSON()) });
  } catch (err) {
    console.error('Get all books error:', err);
    res.status(500).json({ message: err.message });
  }
};

// Get books by community
const getBooksByCommunity = async (req, res) => {
  const { communityId } = req.params;
  
  try {
    if (req.user.role !== 'admin' && req.user.community_id !== parseInt(communityId)) {
      return res.status(403).json({ message: 'Басқа қоғамдастықтың кітаптарын көре алмайсыз' });
    }

    const books = await Book.findAll({
      where: { community_id: communityId },
      include: [
        { 
          model: User, 
          as: 'holder', 
          attributes: ['id', 'name', 'email', 'phone'],
          required: false
        },
        { 
          model: User, 
          as: 'initialHolder', 
          attributes: ['id', 'name', 'email', 'phone'],
          required: false
        },
        { 
          model: Community, 
          attributes: ['id', 'name'],
          required: false
        },
        { 
          model: db.BookHistory, 
          as: 'history',
          include: [
            { 
              model: User, 
              as: 'borrower', 
              attributes: ['id', 'name', 'phone'],
              required: false
            }
          ],
          separate: true,
          order: [['returned_at', 'DESC']],
          limit: 1,
          required: false
        }
      ],
      order: [['id', 'ASC']]
    });

    res.json({ books: books.map(b => b.toJSON()) });
  } catch (err) {
    console.error('Get books by community error:', err);
    res.status(500).json({ message: err.message });
  }
};

// Add book - WITH INITIAL HOLDER
const addBook = async (req, res) => {
  const { title, author, community_id, borrow_days, image_url, genre, initial_holder_id } = req.body;
  
  try {
    const isAdmin = req.user.role === 'admin';
    
    if (!isAdmin) {
      const community = await Community.findByPk(community_id);
      
      if (!community) {
        return res.status(404).json({ message: 'Қоғамдастық табылмады' });
      }
      
      if (community.owner_id !== req.user.id) {
        return res.status(403).json({ 
          message: 'Сіз тек өз қоғамдастығыңызға кітап қоса аласыз' 
        });
      }
    }
    
    const book = await Book.create({ 
      title, 
      author, 
      community_id,
      borrow_days: borrow_days || 14,
      image_url: image_url || null,
      genre: genre || null,
      initial_holder_id: initial_holder_id || null
    });
    
    // Reload with associations
    await book.reload({
      include: [
        { 
          model: User, 
          as: 'initialHolder', 
          attributes: ['id', 'name', 'email', 'phone'],
          required: false
        }
      ]
    });
    
    res.json({ message: 'Book қосылды', book: book.toJSON() });
  } catch (err) {
    console.error('Add book error:', err);
    res.status(500).json({ message: err.message });
  }
};

// Delete book
const deleteBook = async (req, res) => {
  const { id } = req.params;
  
  try {
    const book = await Book.findByPk(id, {
      include: [
        { 
          model: Community,
          required: false
        }
      ]
    });
    
    if (!book) {
      return res.status(404).json({ message: 'Book табылмады' });
    }
    
    const isAdmin = req.user.role === 'admin';
    const isOwner = book.Community && book.Community.owner_id === req.user.id;
    
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ 
        message: 'Сіз тек өз қоғамдастығыңыздағы кітаптарды өшіре аласыз' 
      });
    }
    
    await book.destroy();
    res.json({ message: 'Book өшірілді' });
  } catch (err) {
    console.error('Delete book error:', err);
    res.status(500).json({ message: err.message });
  }
};

module.exports = { 
  assignBook, 
  returnBook, 
  borrowBook,
  returnMyBook,
  getAllBooks, 
  getBooksByCommunity,
  addBook, 
  deleteBook 
};